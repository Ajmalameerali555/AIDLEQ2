// server.js (v2: adds profile/history flow and logging)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.join(__dirname, 'app');
const KB_DIR  = path.join(__dirname, 'kb');
const UP_DIR  = path.join(__dirname, 'uploads');
const DATA_DIR= path.join(__dirname, 'data');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Static
app.use('/', express.static(APP_DIR));
app.use('/uploads', express.static(UP_DIR));

// Multer (uploads)
const upload = multer({
  dest: UP_DIR,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || '4868';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const TTS_URL   = 'https://api.openai.com/v1/audio/speech';
const STT_URL   = 'https://api.openai.com/v1/audio/transcriptions';

// IMPORTANT: Your fine-tuned model id
const MODEL_ID  = 'ft:gpt-4.1-nano-2025-04-14:aj-solutions:aidlex-uae-legal-2025-07:CTOxAkj9';
const EMBED_MODEL = 'text-embedding-3-large';

// ===== Helpers =====
async function openaiChat(messages, { temperature=0.2, max_tokens=1200 } = {}) {
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages, temperature, max_tokens })
  });
  if (!r.ok) throw new Error(`OpenAI chat error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}
async function openaiEmbed(texts) {
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts })
  });
  if (!r.ok) throw new Error(`OpenAI embed error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data.map(d => d.embedding);
}
function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0; i<a.length && i<b.length; i++) { const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot / ((Math.sqrt(na)*Math.sqrt(nb)) || 1);
}

// Data helpers
const PROFILES_FP = path.join(DATA_DIR, 'profiles.json');
const HISTORY_FP  = path.join(DATA_DIR, 'history.json');
const METRIC_STATE = {
  start: Date.now(),
  activeSSE: 0,
  incrementSSE() { this.activeSSE += 1; },
  decrementSSE() { this.activeSSE = Math.max(0, this.activeSSE - 1); }
};
app.locals.metrics = METRIC_STATE;

const adminRateLimitWindowMs = 60 * 1000;
const adminRateLimitMax = 10;
const adminRateHits = new Map();
const adminCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of adminRateHits.entries()) {
    const recent = hits.filter(ts => now - ts <= adminRateLimitWindowMs);
    if (recent.length) adminRateHits.set(ip, recent);
    else adminRateHits.delete(ip);
  }
}, adminRateLimitWindowMs);
if (typeof adminCleanupTimer.unref === 'function') adminCleanupTimer.unref();

function adminRateLimiter(req, res, next) {
  const now = Date.now();
  const windowStart = now - adminRateLimitWindowMs;
  const ip = (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').toString();
  const hits = adminRateHits.get(ip) || [];
  const recent = hits.filter(ts => ts > windowStart);
  recent.push(now);
  adminRateHits.set(ip, recent);
  if (recent.length > adminRateLimitMax) {
    res.set('Retry-After', Math.ceil(adminRateLimitWindowMs / 1000));
    return res.status(429).json({ error: 'Too many admin requests. Please slow down.' });
  }
  next();
}

function ensureAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function toMB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function countFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) count += countFilesRecursive(full);
    else count += 1;
  }
  return count;
}
function readJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return fallback; }
}
function writeJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}
function logEvent(mobile, type, summary) {
  const history = readJSON(HISTORY_FP, []);
  history.push({ ts: Date.now(), mobile: mobile || 'unknown', type, summary });
  // Keep last 1000 entries
  if (history.length > 1000) history.splice(0, history.length - 1000);
  writeJSON(HISTORY_FP, history);
}

// ===== KB (embedding index at boot) =====
const kbFiles = [];
const kbChunks = [];

function readAllFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    const full = path.join(dir, e);
    const s = fs.statSync(full);
    if (s.isDirectory()) out.push(...readAllFiles(full));
    else if (e.endsWith('.md')) out.push(full);
  }
  return out;
}
function parseFrontJSON(s) {
  s = s.trim();
  if (!s.startsWith('{')) return [null, s];
  let depth = 0, end = -1;
  for (let i=0;i<s.length;i++){
    if (s[i]==='{') depth++;
    if (s[i]==='}') { depth--; if (depth===0){ end = i+1; break; } }
  }
  if (end<0) return [null, s];
  try {
    const meta = JSON.parse(s.slice(0,end));
    const body = s.slice(end).trim();
    return [meta, body];
  } catch { return [null, s]; }
}
function splitENAR(body) {
  const SEP = '\n— — —\n';
  const [en, ar] = body.includes(SEP) ? body.split(SEP) : [body, ''];
  return [en.trim(), ar.trim()];
}
function chunk(text, size=2500, overlap=250) {
  const out = [];
  let i=0; while (i<text.length) { out.push(text.slice(i, i+size)); i += (size - overlap); }
  return out;
}
function extractSection(md, title){
  const idx = md.indexOf(title);
  if (idx<0) return '';
  const after = md.slice(idx + title.length);
  const next = after.indexOf('\n**');
  const section = next>=0 ? after.slice(0,next) : after;
  return section.trim().replace(/^\s*[\r\n]+/,'').slice(0, 600);
}
async function indexKB() {
  kbFiles.length = 0; kbChunks.length = 0;
  const files = readAllFiles(KB_DIR);
  for (const fp of files) {
    const raw = fs.readFileSync(fp, 'utf-8');
    const [meta, body] = parseFrontJSON(raw);
    if (!meta) continue;
    const [en, ar] = splitENAR(body);
    const id = path.basename(fp, '.md');
    const fileRec = {
      id, file: fp, meta,
      summaryEN: extractSection(en, '**Summary**'),
      summaryAR: extractSection(ar, '**Summary**'),
      bodyEN: en, bodyAR: ar
    };
    kbFiles.push(fileRec);
    const textForEmbed = `${JSON.stringify(meta)}\n${en}\n${ar}`;
    const parts = chunk(textForEmbed, 2500, 250);
    const embeds = await openaiEmbed(parts);
    embeds.forEach((emb, idx) => {
      kbChunks.push({ id: `${id}#${idx}`, fileId: id, text: parts[idx], meta, embedding: emb });
    });
  }
}
await indexKB();

// ===== System Prompts =====
const SYS_BASE = `You are AIDLEX.AE, a bilingual UAE-legal assistant. Style: formal, precise, premium.
Always answer in English first, then a separator line '— — —', then Arabic (Modern Standard with UAE tone).
If information is jurisdiction-dependent, clearly label the emirate/forum. Add a short, non-legal-advice disclaimer at the end.
Ask exactly one clarifying question if a key fact is missing.
Provide an Outlook block (bullets + timelines + next 1–3 steps).`;

const SYS_MEMO = `You draft Dubai-court memoranda (صحيفة/مذكرة) with strict print-ready HTML.
Rules:
- Return HTML only. Two sections: EN (LTR), then AR (RTL).
- Center main headers. Use formal salutations (e.g., "To the Honorable Court" / "إلى سعادة المحكمة الموقرة").
- Structure: Court header, Parties, Subject, Facts, Legal Basis (high-level references only), Requests, Attachments list, Signature block.
- Include an "Evidence Checklist" box.
- Respect provided facts; do not invent.
- Dates ISO; Arabic section uses Arabic-Indic digits if possible.
- Add a brief non-legal-advice note.`;

const SYS_PREFLIGHT = `You are a UAE memo pre-flight assistant. Output STRICT JSON only:
{"questions":[{"en":"...","ar":"..."}, ...], "evidence":["...","..."], "notes":["..."]}.
Questions: up to 5 essential gaps (dates, amounts, contract refs, notices served, jurisdiction/forum).`;

const SYS_TRANSLATE = `You are a certified-style legal translator to Arabic (UAE). Maintain banking/cheque/legal phrasing (شيك، كشف حساب، سند).
Keep ISO dates; maintain paragraph layout. If "Add certification: true", append a short certification footer. Return Arabic text only.`;

const SYS_LETTER = `You generate formal letters/complaints (EN then AR) for UAE authorities with clear headers, subject, facts, request, closing, signature block. Avoid statute text; cite Article #/Year/Title only if needed. Return HTML.`;

// ===== Routes =====

// Save profile
app.post('/api/profile', (req, res) => {
  try {
    const { name, mobile, email } = req.body || {};
    if (!mobile || !name) return res.status(400).json({ error: 'name and mobile required' });
    const profiles = readJSON(PROFILES_FP, []);
    const ix = profiles.findIndex(p => p.mobile === mobile);
    const rec = { name, mobile, email: email || '', ts: Date.now() };
    if (ix >= 0) profiles[ix] = { ...profiles[ix], ...rec };
    else profiles.push(rec);
    writeJSON(PROFILES_FP, profiles);
    logEvent(mobile, 'profile', `Profile saved for ${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// History retrieval
app.get('/api/history', (req, res) => {
  try {
    const mobile = String(req.query.mobile || '');
    const hist = readJSON(HISTORY_FP, [])
      .filter(h => !mobile || h.mobile === mobile)
      .sort((a,b)=> b.ts - a.ts)
      .slice(0, 50);
    res.json({ items: hist });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Upload evidence
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  try {
    const mobile = (req.headers['x-mobile'] || '').toString();
    const files = (req.files || []).map(f => ({
      name: f.originalname,
      url: `/uploads/${path.basename(f.path)}`
    }));
    if (files.length) logEvent(mobile, 'upload', `Uploaded ${files.length} file(s)`);
    res.json({ files });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// TTS (fallback) - OpenAI tts-1 -> mp3
app.post('/api/tts', async (req, res) => {
  try {
    const text = await new Promise(resolve => {
      let data = ''; req.setEncoding('utf8');
      req.on('data', chunk => data += chunk); req.on('end', () => resolve(data));
    });
    const r = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: 'verse',   // female-like voice
        input: text,
        format: 'mp3'
      })
    });
    if (!r.ok) throw new Error(await r.text());
    res.setHeader('Content-Type', 'audio/mpeg');
    r.body.pipe(res);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// STT (Whisper)
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'audio missing' });
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('file', fs.createReadStream(f.path), { filename: f.originalname || 'audio.webm' });
    const r = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: form
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    res.json({ text: j.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Chat (streaming via SSE when available, fallback to POST)
app.get('/api/chat', async (req, res) => {
  const rawPayload = req.query?.payload;
  if (!rawPayload) return res.status(400).json({ error: 'missing payload' });
  let payload;
  try { payload = JSON.parse(rawPayload); }
  catch { return res.status(400).json({ error: 'invalid payload' }); }
  const q = String(payload?.query ?? '').slice(0, 8000);
  if (!q) return res.status(400).json({ error: 'empty query' });
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const profile = (payload?.profile && typeof payload.profile === 'object') ? payload.profile : {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const contextNote = files.length ? `Attached files (URLs):\n${files.join('\n')}\n` : '';
  const messages = [
    { role: 'system', content: SYS_BASE },
    { role: 'user', content: `User: ${profile.name||''} ${profile.mobile||''} ${profile.email||''}\n${contextNote}${q}` }
  ];

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let doneSent = false;
  const sendDone = () => {
    if (doneSent || res.writableEnded) return;
    doneSent = true;
    res.write('event: done\ndata: {}\n\n');
    res.end();
  };

  let fullText = '';
  try {
    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ID, messages, temperature: 0.2, max_tokens: 1200, stream: true }),
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`OpenAI chat error ${r.status}: ${await r.text()}`);
    if (!r.body) throw new Error('OpenAI stream missing body');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n');
        let dataStr = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          dataStr += trimmed.slice(5).trimStart();
        }
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
          sendDone();
          logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}... | A: ${fullText.slice(0,100)}...`);
          return;
        }
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch (err) {
          // ignore malformed chunks
        }
      }
    }
    sendDone();
    logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}... | A: ${fullText.slice(0,100)}...`);
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err?.message || String(err);
    if (!res.writableEnded) {
      res.write(`event: server-error\ndata: ${JSON.stringify({ message })}\n\n`);
      sendDone();
    }
    logEvent(profile.mobile, 'chat-error', `Q: ${q.slice(0,100)}... :: ${message}`);
  }
});

// Chat (attachments listed as context)
app.post('/api/chat', async (req, res) => {
  const accept = String(req.headers?.accept || '');
  const q = String(req.body?.query ?? '').slice(0, 8000);
  const files = req.body?.files || [];
  const profile = req.body?.profile || {};
  const contextNote = files.length ? `Attached files (URLs):\n${files.join('\n')}\n` : '';
  const messages = [
    { role: 'system', content: SYS_BASE },
    { role: 'user', content: `User: ${profile.name||''} ${profile.mobile||''} ${profile.email||''}\n${contextNote}${q}` }
  ];

  if (accept.includes('text/event-stream')) {
    const controller = new AbortController();
    let closed = false;
    const finish = () => {
      if (!closed) {
        closed = true;
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    req.on('close', () => {
      controller.abort();
      finish();
    });

    try {
      const r = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL_ID,
          messages,
          temperature: 0.2,
          max_tokens: 1200,
          stream: true
        }),
        signal: controller.signal
      });

      if (!r.ok || !r.body) {
        const errText = !r.ok ? await r.text() : 'No response body';
        throw new Error(`OpenAI chat stream error ${r.status}: ${errText}`);
      }

      const decoder = new TextDecoder();
      const reader = r.body.getReader();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n');
            finish();
            logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}...`);
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            }
          } catch (err) {
            res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
          }
        }
      }

      res.write('data: [DONE]\n\n');
      finish();
      logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}...`);
    } catch (e) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      finish();
    }
    return;
  }

  try {
    const txt = await openaiChat(messages);
    logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}...`);
    res.json({ text: txt });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Memo: preflight then final
app.post('/api/memo', async (req, res) => {
  try {
    const p = req.body || {};
    const profile = p.profile || {};
    const required = ['forum','caseType','claimantEN','defendantEN','claimantAR','defendantAR','factsEN','factsAR','reliefEN','reliefAR'];
    for (const k of required) if (!p[k]) throw new Error(`Missing field: ${k}`);

    if (!p.confirm) {
      const preflightJson = await openaiChat([
        { role: 'system', content: SYS_PREFLIGHT },
        { role: 'user', content:
`Forum: ${p.forum}
Case type: ${p.caseType}
Claimant EN: ${p.claimantEN}
Defendant EN: ${p.defendantEN}
Claimant AR: ${p.claimantAR}
Defendant AR: ${p.defendantAR}
Dates: ${p.dates||'-'}
Facts EN: ${p.factsEN}
Facts AR: ${p.factsAR}
Relief EN: ${p.reliefEN}
Relief AR: ${p.reliefAR}
Evidence EN: ${p.evidenceEN||'-'}
Evidence AR: ${p.evidenceAR||'-'}`}], { max_tokens: 700 });
      let payload;
      try { payload = JSON.parse(preflightJson); }
      catch { payload = { questions:[], evidence:[], notes:[] }; }
      logEvent(profile.mobile, 'memo-preflight', `Case: ${p.caseType}`);
      return res.json({ stage:'preflight', ...payload });
    }

    const attachments = (p.attachments||[]).map((u,i)=> `${i+1}) ${u}`).join('\n');
    const html = await openaiChat([
      { role: 'system', content: SYS_MEMO },
      { role: 'user', content:
`Forum: ${p.forum}
Case: ${p.caseType}
Parties:
- Claimant (EN): ${p.claimantEN}
- Defendant (EN): ${p.defendantEN}
- المدعي: ${p.claimantAR}
- المدعى عليه: ${p.defendantAR}

Dates (ISO): ${p.dates||'-'}

Facts (EN):
${p.factsEN}

Facts (AR):
${p.factsAR}

Requested Relief (EN):
${p.reliefEN}

الطلبات (AR):
${p.reliefAR}

Evidence EN: ${p.evidenceEN||'-'}
Evidence AR: ${p.evidenceAR||'-'}

Attachments (URLs):
${attachments || '-'}
Please produce printable HTML with EN then AR, centered headers, formal salutations, signature block, and an evidence checklist.` }
    ], { max_tokens: 1800 });
    logEvent(profile.mobile, 'memo', `Generated memo for ${p.caseType}`);
    res.json({ stage:'final', html });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// Translation
app.post('/api/translate', async (req, res) => {
  try {
    const { source, certify, kb, profile } = req.body || {};
    if (!source) throw new Error('Missing source text');
    const txt = await openaiChat([
      { role: 'system', content: SYS_TRANSLATE },
      { role: 'user', content: `Add certification: ${!!certify}. Use UAE phrasing: ${!!kb}. TEXT:\n${source}` }
    ], { max_tokens: 1200 });
    logEvent(profile?.mobile, 'translate', `Chars: ${source.length}`);
    res.json({ arabic: txt });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// Formal letter / complaint
app.post('/api/letter', async (req, res) => {
  try {
    const p = req.body || {};
    const html = await openaiChat([
      { role: 'system', content: SYS_LETTER },
      { role: 'user', content:
`Department/Authority: ${p.dept||'-'}
Purpose: ${p.purpose||'-'}
Facts EN: ${p.factsEN||'-'}
Facts AR: ${p.factsAR||'-'}
Generate EN then AR, with subject, body, and signature.` }
    ], { max_tokens: 1200 });
    logEvent(p.profile?.mobile, 'letter', `Dept: ${p.dept||'-'}`);
    res.json({ html });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// KB: embeddings search
app.post('/api/kb/search', async (req, res) => {
  try {
    const q = String(req.body?.q || '').trim();
    if (!q) return res.json({ items: [] });
    const [qEmb] = await openaiEmbed([q]);
    const scored = kbChunks.map(ch => ({ ...ch, score: cosine(qEmb, ch.embedding) }))
                           .sort((a,b)=> b.score - a.score).slice(0, 20);
    const seen = new Set();
    const items = [];
    for (const sc of scored) {
      if (seen.has(sc.fileId)) continue;
      seen.add(sc.fileId);
      const file = kbFiles.find(f => f.id === sc.fileId);
      if (file) items.push({
        id: file.id, title: file.meta.title, jurisdiction: file.meta.jurisdiction,
        version: file.meta.version, as_of: file.meta.as_of,
        summaryEN: file.summaryEN, summaryAR: file.summaryAR, tags: file.meta.tags
      });
      if (items.length >= 5) break;
    }
    res.json({ items });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// KB: re-index
app.post('/api/kb/index', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== ADMIN_KEY) return res.status(403).json({ error:'Forbidden' });
    await indexKB(); res.json({ ok:true, files: kbFiles.length, chunks: kbChunks.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const adminRouter = express.Router();
adminRouter.use(adminRateLimiter);
adminRouter.use(ensureAdminKey);
adminRouter.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const memory = {
    rssMB: toMB(memoryUsage.rss),
    heapTotalMB: toMB(memoryUsage.heapTotal),
    heapUsedMB: toMB(memoryUsage.heapUsed),
    externalMB: toMB(memoryUsage.external)
  };
  const history = readJSON(HISTORY_FP, []);
  const cutoff = Date.now() - (12 * 60 * 60 * 1000);
  const sessions = new Set(
    history
      .filter(h => h && typeof h === 'object' && h.ts >= cutoff && h.mobile && h.mobile !== 'unknown')
      .map(h => h.mobile)
  ).size;
  const uploads = countFilesRecursive(UP_DIR);
  const uptimeSeconds = Number(((Date.now() - METRIC_STATE.start) / 1000).toFixed(1));
  res.json({
    uptime: uptimeSeconds,
    memory,
    sessions,
    kbReady: kbChunks.length > 0,
    uploads,
    SSEconnections: METRIC_STATE.activeSSE
  });
});

app.use('/admin', adminRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AIDLEX.AE running on http://localhost:${port}`));
