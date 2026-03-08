# NanoClaw Lite (Serverless)

NanoClaw Lite is a serverless-friendly variant of NanoClaw. It keeps Claude Agent SDK as the execution core, but switches from long-running multi-channel orchestration to request-driven HTTP APIs.

## What Changed

- Agent execution now runs in the same container/process as NanoClaw (no per-request `docker run` child container).
- Skills and memory are mounted from volumes (`/data/skills`, `/data/memory`, `/data/sessions`, `/data/store`).
- HTTP API replaces Telegram/WhatsApp/Slack channel adapters.
- Multi-turn state is persisted in SQLite + Claude session resume metadata.
- Scheduled tasks are externally triggered by `/task/check` (EventBridge/FC timer).

Detailed operations and deployment guide: `docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`.

## API Overview

- `GET /health`
- `POST /chat`
- `GET /chat/:conversation_id`
- `POST /task`
- `GET /tasks`
- `PUT /task/:task_id`
- `DELETE /task/:task_id`
- `POST /task/trigger`
- `POST /task/check`

All routes except `/health` require:

```http
Authorization: Bearer <API_TOKEN>
```

## Local Development

```bash
npm ci
npm run build
npm start
```

or with Docker:

```bash
make docker-build
make docker-run
```

## Required Environment Variables

- `ANTHROPIC_API_KEY` (or Claude Code OAuth token equivalent)
- `API_TOKEN`

Optional:

- `PORT` (default `9000`)
- `MAX_EXECUTION_MS` (default `300000`)
- `ASSISTANT_NAME` (default `Andy`)
- `TZ` (default system timezone)

## Build Image

```bash
docker build --platform linux/amd64 -t nanoclaw-lite:latest .
```

For AWS Lambda Web Adapter:

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t nanoclaw-lite:lambda .
```
