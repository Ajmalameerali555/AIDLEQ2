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
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.join(__dirname, 'app');
const KB_DIR  = path.join(__dirname, 'kb');
const UP_DIR  = path.join(__dirname, 'uploads');
const DATA_DIR= path.join(__dirname, 'data');
const KB_CACHE_FP = path.join(DATA_DIR, 'kb-index.json');
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
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const TTS_URL   = 'https://api.openai.com/v1/audio/speech';
const STT_URL   = 'https://api.openai.com/v1/audio/transcriptions';
const MISSING_KEY_MESSAGE = 'OpenAI API key is not configured. Set OPENAI_API_KEY environment variable and restart the server.';

function ensureOpenAIKey() {
  if (!OPENAI_API_KEY) {
    const err = new Error(MISSING_KEY_MESSAGE);
    err.status = 503;
    err.code = 'NO_OPENAI_KEY';
    throw err;
  }
  return OPENAI_API_KEY;
}

function handleAIError(res, error, defaultStatus = 500) {
  if (error?.status === 503 || error?.code === 'NO_OPENAI_KEY') {
    return res.status(503).json({
      error: error.message,
      action: 'Set the OPENAI_API_KEY environment variable and restart the server.'
    });
  }
  return res.status(defaultStatus).json({ error: String(error) });
}

// IMPORTANT: Your fine-tuned model id
const MODEL_ID  = 'ft:gpt-4.1-nano-2025-04-14:aj-solutions:aidlex-uae-legal-2025-07:CTOxAkj9';
const EMBED_MODEL = 'text-embedding-3-large';

// ===== Helpers =====
async function openaiChat(messages, { temperature=0.2, max_tokens=1200 } = {}) {
  ensureOpenAIKey();
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
  ensureOpenAIKey();
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
let kbLoaded = false;
let kbLoadPromise = null;
let kbCacheMeta = { savedAt: null };

function setKBData(files, chunks) {
  kbFiles.length = 0;
  kbFiles.push(...files);
  kbChunks.length = 0;
  kbChunks.push(...chunks);
  kbLoaded = true;
}

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
function loadKBCache() {
  if (!fs.existsSync(KB_CACHE_FP)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(KB_CACHE_FP, 'utf-8'));
    if (!Array.isArray(data.files) || !Array.isArray(data.chunks)) return null;
    setKBData(data.files, data.chunks);
    kbCacheMeta = { savedAt: data.savedAt || null };
    return { files: kbFiles.length, chunks: kbChunks.length, savedAt: kbCacheMeta.savedAt, cachePath: KB_CACHE_FP, durationMs: null };
  } catch (err) {
    console.warn('Failed to load KB cache:', err);
    return null;
  }
}

async function indexKB() {
  const start = Date.now();
  const indexedFiles = [];
  const indexedChunks = [];
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
    indexedFiles.push(fileRec);
    const textForEmbed = `${JSON.stringify(meta)}\n${en}\n${ar}`;
    const parts = chunk(textForEmbed, 2500, 250);
    if (parts.length) {
      const embeds = await openaiEmbed(parts);
      embeds.forEach((emb, idx) => {
        indexedChunks.push({ id: `${id}#${idx}`, fileId: id, text: parts[idx], meta, embedding: emb });
      });
    }
  }
  setKBData(indexedFiles, indexedChunks);
  const savedAt = new Date().toISOString();
  kbCacheMeta = { savedAt };
  writeJSON(KB_CACHE_FP, { version: 1, savedAt, files: indexedFiles, chunks: indexedChunks });
  return {
    files: indexedFiles.length,
    chunks: indexedChunks.length,
    savedAt,
    cachePath: KB_CACHE_FP,
    durationMs: Date.now() - start
  };
}

async function ensureKbLoaded({ forceReindex = false } = {}) {
  if (forceReindex) {
    const result = await indexKB();
    const payload = { source: 'reindex', ...result };
    kbLoadPromise = Promise.resolve(payload);
    return payload;
  }
  if (kbLoaded) {
    return { source: 'hot', files: kbFiles.length, chunks: kbChunks.length, savedAt: kbCacheMeta.savedAt, cachePath: KB_CACHE_FP, durationMs: null };
  }
  if (!kbLoadPromise) {
    kbLoadPromise = (async () => {
      const cache = loadKBCache();
      if (cache) return { source: 'cache', ...cache };
      const indexed = await indexKB();
      return { source: 'built', ...indexed };
    })();
  }
  const result = await kbLoadPromise;
  kbLoadPromise = Promise.resolve(result);
  return result;
}

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
    ensureOpenAIKey();
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
  } catch (e) { handleAIError(res, e); }
});

// STT (Whisper)
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    ensureOpenAIKey();
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
  } catch (e) { handleAIError(res, e); }
});

// Chat (attachments listed as context)
app.post('/api/chat', async (req, res) => {
  try {
    const q = String(req.body?.query ?? '').slice(0, 8000);
    const files = req.body?.files || [];
    const profile = req.body?.profile || {};
    const contextNote = files.length ? `Attached files (URLs):\n${files.join('\n')}\n` : '';
    const txt = await openaiChat([
      { role: 'system', content: SYS_BASE },
      { role: 'user', content: `User: ${profile.name||''} ${profile.mobile||''} ${profile.email||''}\n${contextNote}${q}` }
    ]);
    logEvent(profile.mobile, 'chat', `Q: ${q.slice(0,100)}...`);
    res.json({ text: txt });
  } catch (e) { handleAIError(res, e); }
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
  } catch (e) { handleAIError(res, e, 400); }
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
  } catch (e) { handleAIError(res, e, 400); }
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
  } catch (e) { handleAIError(res, e, 400); }
});

// KB: embeddings search
app.post('/api/kb/search', async (req, res) => {
  try {
    const q = String(req.body?.q || '').trim();
    if (!q) return res.json({ items: [] });
    await ensureKbLoaded();
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
  } catch (e) { handleAIError(res, e); }
});

// KB: re-index
app.post('/api/kb/index', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY||'4868')) return res.status(403).json({ error:'Forbidden' });
    const result = await ensureKbLoaded({ forceReindex: true });
    res.json({ ok:true, ...result });
  } catch (e) {
    if (e?.status === 503 || e?.code === 'NO_OPENAI_KEY') return handleAIError(res, e);
    res.status(500).json({ error: String(e), details: e?.stack });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AIDLEX.AE running on http://localhost:${port}`));
