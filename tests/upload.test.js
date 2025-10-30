import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import app, { SECURE_UPLOAD_DIR, UPLOADS_META_FP } from '../server.js';

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    await fn({ baseURL: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

beforeEach(() => {
  fs.rmSync(SECURE_UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(SECURE_UPLOAD_DIR, { recursive: true });
  fs.rmSync(UPLOADS_META_FP, { force: true });
});

test('accepts allowed MIME types and returns metadata', { concurrency: false }, async () => {
  await withServer(async ({ baseURL }) => {
    const form = new FormData();
    const file = new File([Buffer.from('%PDF-1.4')], 'evidence.pdf', { type: 'application/pdf' });
    form.append('files', file);

    const res = await fetch(`${baseURL}/api/upload`, {
      method: 'POST',
      headers: { 'x-mobile': '0501234567' },
      body: form
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.files));
    assert.equal(body.files.length, 1);
    const uploaded = body.files[0];
    assert.equal(uploaded.name, 'evidence.pdf');
    assert.match(uploaded.url, /\/api\/uploads\//);
    assert.ok(uploaded.url.includes('token='));

    const metadata = JSON.parse(fs.readFileSync(UPLOADS_META_FP, 'utf-8'));
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].originalName, 'evidence.pdf');
    assert.equal(metadata[0].mimetype, 'application/pdf');
    assert.equal(metadata[0].mobile, '0501234567');
    const storedFiles = fs.readdirSync(SECURE_UPLOAD_DIR);
    assert.equal(storedFiles.length, 1);
  });
});

test('rejects disallowed MIME types with 415 status', { concurrency: false }, async () => {
  await withServer(async ({ baseURL }) => {
    const form = new FormData();
    const file = new File([Buffer.from('binary')], 'malware.exe', { type: 'application/x-msdownload' });
    form.append('files', file);

    const res = await fetch(`${baseURL}/api/upload`, {
      method: 'POST',
      body: form
    });

    assert.equal(res.status, 415);
    const body = await res.json();
    assert.equal(body.error, 'Unsupported media type');

    const exists = fs.existsSync(UPLOADS_META_FP);
    if (exists) {
      const metadata = JSON.parse(fs.readFileSync(UPLOADS_META_FP, 'utf-8'));
      assert.equal(metadata.length, 0);
    }
    const storedFiles = fs.readdirSync(SECURE_UPLOAD_DIR);
    assert.equal(storedFiles.length, 0);
  });
});
