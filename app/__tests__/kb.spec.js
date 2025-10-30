import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { KB_CACHE_VERSION } from '../lib/kbVersion.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidle-kb-'));
}

function setupEnvironment() {
  const originalEnv = { ...process.env };
  const tmpDir = makeTempDir();
  process.env.DATA_DIR = tmpDir;
  process.env.KB_CACHE_DIR = tmpDir;
  process.env.ADMIN_KEY = 'test-admin';
  process.env.KB_EMBED_STRATEGY = 'stub';
  return {
    tmpDir,
    cachePath: path.join(tmpDir, 'kb_cache.json'),
    async cleanup() {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

async function importServer() {
  const mod = await import(`../../server.js?ts=${Date.now()}&rand=${Math.random()}`);
  await mod.kbReady;
  return mod;
}

async function postJson(app, route, headers = {}) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine test server address');
    }
    const url = `http://127.0.0.1:${address.port}${route}`;
    const response = await fetch(url, { method: 'POST', headers });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('hydrates KB from cache when version matches', async () => {
  const ctx = setupEnvironment();
  try {
    const sampleMeta = { title: 'Demo', jurisdiction: 'test', version: '1.0', as_of: '2024-01-01', tags: ['demo'] };
    const payload = {
      version: KB_CACHE_VERSION,
      generatedAt: 123,
      files: [{
        id: 'demo',
        file: '/tmp/demo.md',
        meta: sampleMeta,
        summaryEN: 'summary',
        summaryAR: 'ملخص',
        bodyEN: 'body',
        bodyAR: 'body'
      }],
      chunks: [{
        id: 'demo#0',
        fileId: 'demo',
        text: 'chunk',
        meta: sampleMeta,
        embedding: [0, 1, 2]
      }]
    };
    fs.writeFileSync(ctx.cachePath, JSON.stringify(payload));

    const serverModule = await importServer();
    const state = serverModule.getKbState();

    assert.equal(state.info.source, 'cache');
    assert.equal(state.info.version, KB_CACHE_VERSION);
    assert.equal(state.files[0]?.id, 'demo');
    const disk = JSON.parse(fs.readFileSync(ctx.cachePath, 'utf-8'));
    assert.equal(disk.version, KB_CACHE_VERSION);
  } finally {
    await ctx.cleanup();
  }
});

test('reindexes when cache version mismatches', async () => {
  const ctx = setupEnvironment();
  try {
    fs.writeFileSync(ctx.cachePath, JSON.stringify({
      version: KB_CACHE_VERSION - 1,
      files: [],
      chunks: []
    }));

    const serverModule = await importServer();
    const state = serverModule.getKbState();

    assert.equal(state.info.source, 'reindex');
    assert.equal(state.info.version, KB_CACHE_VERSION);
    assert.ok(state.info.files > 0);
    const disk = JSON.parse(fs.readFileSync(ctx.cachePath, 'utf-8'));
    assert.equal(disk.version, KB_CACHE_VERSION);
  } finally {
    await ctx.cleanup();
  }
});

test('cache refresh endpoint triggers reindex', async () => {
  const ctx = setupEnvironment();
  try {
    const serverModule = await importServer();
    const embedMock = async texts => texts.map((_, idx) => Array(3).fill(idx));
    serverModule.setKbEmbedder(embedMock);

    const res = await postJson(serverModule.app, '/api/kb/reindex-cache', { 'x-admin-key': 'test-admin' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.version, KB_CACHE_VERSION);
    assert.equal(typeof res.body.generatedAt, 'number');
    const stateAfter = serverModule.getKbState();
    assert.equal(stateAfter.info.source, 'reindex');
  } finally {
    await ctx.cleanup();
  }
});
