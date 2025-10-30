// server.js (v2: adds profile/history flow and logging)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
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
const DATA_DIR= path.join(__dirname, 'data');
const SECURE_UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const UPLOADS_META_FP = path.join(DATA_DIR, 'uploads.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SECURE_UPLOAD_DIR)) fs.mkdirSync(SECURE_UPLOAD_DIR, { recursive: true });

// Static
app.use('/', express.static(APP_DIR));

// Multer (uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SECURE_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = randomUUID();
    const ext = path.extname(file.originalname || '').slice(0, 20);
    const safeExt = ext.replace(/[^\w.\-]/g, '');
    const storedName = `${id}${safeExt}`;
    file.uploadId = id;
    file.storedFilename = storedName;
    cb(null, storedName);
  }
});

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const evidenceFileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  const err = new Error(`Unsupported media type: ${file.mimetype}`);
  err.statusCode = 415;
  cb(err);
};

const uploadEvidence = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: evidenceFileFilter
});

const uploadAudio = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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
if (process.env.NODE_ENV !== 'test') {
  await indexKB();
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
function persistUploads(records) {
  const existing = readJSON(UPLOADS_META_FP, []);
  existing.push(...records);
  writeJSON(UPLOADS_META_FP, existing);
}

function buildDownloadUrl(id, token) {
  return `/api/uploads/${id}?token=${token}`;
}

app.post('/api/upload', (req, res) => {
  uploadEvidence.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.statusCode === 415) return res.status(415).json({ error: 'Unsupported media type' });
      return res.status(400).json({ error: err.message });
    }
    try {
      const mobile = (req.headers['x-mobile'] || '').toString();
      const savedRecords = [];
      const responseFiles = [];
      for (const f of req.files || []) {
        const token = randomUUID();
        const record = {
          id: f.uploadId,
          token,
          originalName: f.originalname,
          storedFilename: f.storedFilename || f.filename,
          mimetype: f.mimetype,
          size: f.size,
          mobile,
          uploadedAt: Date.now()
        };
        savedRecords.push(record);
        responseFiles.push({ name: record.originalName, url: buildDownloadUrl(record.id, token) });
      }
      if (savedRecords.length) {
        persistUploads(savedRecords);
        logEvent(mobile, 'upload', `Uploaded ${savedRecords.length} file(s)`);
      }
      res.json({ files: responseFiles });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });
});

app.get('/api/uploads/:id', (req, res) => {
  try {
    const token = String(req.query.token || '');
    const id = req.params.id;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const entries = readJSON(UPLOADS_META_FP, []);
    const record = entries.find(r => r.id === id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (record.token !== token) return res.status(403).json({ error: 'Forbidden' });
    const filePath = path.join(SECURE_UPLOAD_DIR, record.storedFilename);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer available' });
    res.setHeader('Content-Type', record.mimetype || 'application/octet-stream');
    const dispositionName = encodeURIComponent(record.originalName || 'download');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${dispositionName}`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
app.post('/api/stt', uploadAudio.single('audio'), async (req, res) => {
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
    if (key !== (process.env.ADMIN_KEY||'4868')) return res.status(403).json({ error:'Forbidden' });
    await indexKB(); res.json({ ok:true, files: kbFiles.length, chunks: kbChunks.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`AIDLEX.AE running on http://localhost:${port}`));
}

export { app, SECURE_UPLOAD_DIR, UPLOADS_META_FP };
export default app;
