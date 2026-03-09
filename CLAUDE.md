# PicoClaw

Serverless-first Claude Agent runtime for HTTP-triggered conversations and scheduled tasks.

## Scope

This repository is no longer the original multi-channel host-orchestrator model.
It is now a trimmed runtime named **PicoClaw** focused on:

- HTTP API invocation
- mounted persistent storage for memory/session/history
- per-request execution in serverless/container platforms

## Non-Negotiable Principles

1. **Memory and conversation history are core features**
- Do not treat memory/history as optional in serverless mode.
- Cross-request personalization depends on persistent mounted paths.

2. **Persistent data model must be preserved**
- `MEMORY_DIR` (default `/data/memory`)
- `STORE_DIR` (default `/data/store`)
- `SESSIONS_DIR` (default `/data/sessions`)
- `SKILLS_DIR` (default `/data/skills`)

3. **Graceful stop must persist data before exit**
- Runtime supports both:
  - API stop: `POST /control/stop`
  - Signal stop: `SIGTERM` / `SIGINT`
- Both paths must retain sync-and-exit behavior.

4. **SDK version alignment with upstream NanoClaw baseline**
- `@anthropic-ai/claude-agent-sdk`: `0.2.34`
- `@modelcontextprotocol/sdk`: `1.12.1`
- Do not downgrade for convenience.

## Architecture Snapshot

- `src/index.ts`: process boot, directory init, shutdown handling
- `src/server.ts`: Express app composition and auth-protected route mounting
- `src/routes/chat.ts`: chat entrypoint, SSE, session-end marker fields
- `src/routes/task.ts`: task CRUD + trigger/check
- `src/routes/control.ts`: graceful stop API
- `src/agent-engine.ts`: Claude Agent SDK query wrapper + hooks
- `src/mcp-server.ts`: MCP tools backed by SQLite
- `src/db.ts`: SQLite schema + persistence sync to mounted volume
- `src/skills.ts`: skill sync and `.claude/settings.json` bootstrap

## API Contract Highlights

- `GET /health`
- `POST /chat`
- `GET /chat/:conversation_id`
- `POST /task`
- `GET /tasks`
- `PUT /task/:task_id`
- `DELETE /task/:task_id`
- `POST /task/trigger`
- `POST /task/check`
- `POST /control/stop`

`POST /chat` response includes:

- `session_end_marker`
- `session_end_marker_detected`

Callers can use marker detection to decide when to invoke `/control/stop`.

## Tooling and Docs

- Main operations guide: `docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`
- OpenAPI spec: `openapi.yaml`
- OpenAPI JSON export: `openapi.json`
- Postman collection: `postman_collection.json`
- One-click startup: `picoclaw.sh`

## Local Workflow

```bash
npm ci
npm run build
npm test
```

Docker flow:

```bash
./picoclaw.sh
./picoclaw.sh test
./picoclaw.sh stop-api
./picoclaw.sh down
```

## Change Guardrails

When modifying runtime behavior, always validate:

- build and tests pass (`npm run build && npm test`)
- OpenAPI remains valid and exports are regenerated
- stop path still persists data and exits cleanly
- memory/history persistence assumptions are not weakened
