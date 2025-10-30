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

## Re-index KB
```bash
curl -X POST http://localhost:3000/api/kb/index -H 'x-admin-key: 4868'
```

## Security and Monitoring
- **Admin key** – privileged endpoints (`/api/kb/index`, `/admin/*`) require the `x-admin-key` header. Set `ADMIN_KEY` in `.env` to override the default `4868`.
- **Admin rate limiting** – `/admin/*` routes are capped at 10 requests per minute per IP to protect the control plane from brute-force or noisy polling.
- **Health endpoint** – `GET /admin/health` (with the admin key) returns uptime, memory usage, recent session counts, KB readiness, upload totals, and active Server-Sent Event (SSE) connections for quick diagnostics.
- **Monitoring tips** – log and alert on repeated 403/429 responses, watch the `kbReady` flag after deployments, and track upload volume to anticipate storage increases.

## Git
```bash
git init
git add -A
git commit -m "AIDLEX.AE v2 flow"
git branch -M main
git remote add origin <YOUR_GIT_REMOTE_URL>
git push -u origin main
```

