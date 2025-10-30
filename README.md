# AIDLEX.AE v2 (Welcome→Profile→History→Services→Workspace)

Clean central onboarding flow with no chat surface until services are chosen. Voice (TTS/STT), memo wizard, translation, letters, uploads, embeddings KB, and server-side **history logging**.

## Run
```bash
npm install
cp .env.example .env
npm run dev
# http://localhost:3000
```

## Environment

Create a `.env` file (you can copy from `.env.example`) and fill in the secrets provided by your team:

```bash
OPENAI_API_KEY=sk-...
SESSION_SECRET=change-me
ADMIN_KEY=4868
```

`OPENAI_API_KEY` powers chat, embedding, TTS, and STT requests. `SESSION_SECRET` secures session cookies or signed payloads. `ADMIN_KEY` protects privileged APIs like the knowledge-base indexer.

## Deploying to Render

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. Create a new **Web Service** on [Render](https://render.com/) and connect the repository.
3. Render automatically detects the `render.yaml` blueprint. Confirm the plan, region, and persistent disks when prompted.
4. Set the required environment variables (`OPENAI_API_KEY`, `SESSION_SECRET`, `ADMIN_KEY`) in the Render dashboard.
5. Trigger the first deploy. The service builds with `npm install` and starts via `npm run dev` on port `3000` (or `PORT` if Render overrides it).
6. Persistent disks are mounted at `/uploads` and `/data` to preserve file uploads and history between deploys.

## Admin Dashboard & Maintenance

- The admin endpoints require the `ADMIN_KEY` sent as an `x-admin-key` header.
- Re-index the knowledge base after uploading new Markdown files:

  ```bash
  curl -X POST https://<your-service>.onrender.com/api/kb/index -H "x-admin-key: $ADMIN_KEY"
  ```
- User profiles are stored in `data/profiles.json`; history is stored in `data/history.json`; uploads persist under `/uploads`.

## Commands

| Command | Description |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run dev` | Start the Express server. |
| `curl -X POST .../api/kb/index` | Trigger a knowledge base re-index (requires `ADMIN_KEY`). |
| `git status` | Inspect working tree changes. |

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

## Git
```bash
git init
git add -A
git commit -m "AIDLEX.AE v2 flow"
git branch -M main
git remote add origin <YOUR_GIT_REMOTE_URL>
git push -u origin main
```

