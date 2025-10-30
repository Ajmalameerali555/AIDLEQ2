# AIDLEX.AE v2 (Welcome→Profile→History→Services→Workspace)

Clean central onboarding flow with no chat surface until services are chosen. Voice (TTS/STT), memo wizard, translation, letters, uploads, embeddings KB, and server-side **history logging**.

## Run
```bash
npm i
cp .env.sample .env   # add OPENAI_API_KEY
npm run dev
# http://localhost:3000
```

## New Flow
1. Welcome (Begin) →
2. Profile (name, mobile, email optional) →
3. Service History (from server log) →
4. Services (centered grid) →
5. Workspace (chat/memo/translate/etc.).

## History
- Stored in `data/history.json`. Profile in `data/profiles.json`.
- Uploads under `/uploads`.

## Knowledge Base cache & reindexing
- Cached embeddings are stored at `data/kb_cache.json` (directory configurable via `DATA_DIR` / `KB_CACHE_DIR`).
- The expected cache version lives in `app/lib/kbVersion.js`. Startup will hydrate from cache and automatically rebuild if the file is missing or the version mismatches.
- Trigger a rebuild with admin auth header (`x-admin-key`):
  - `POST /api/kb/reindex` → rebuilds embeddings, updates cache, returns counts and metadata.
  - `POST /api/kb/reindex-cache` → forces a cache refresh and responds with `{ ok, version, generatedAt }`.
- Cache writes are atomic to avoid corruption under concurrent requests.

## Git
```bash
git init
git add -A
git commit -m "AIDLEX.AE v2 flow"
git branch -M main
git remote add origin <YOUR_GIT_REMOTE_URL>
git push -u origin main
```

