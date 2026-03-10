# PicoClaw Serverless API & Deployment Guide

> Target audience: Operations teams, platform engineers, downstream API consumers

## 1. Document Purpose

This guide covers:

- API usage (authentication, SSE streaming, multi-turn conversations, task scheduling)
- Container deployment (local, AWS Lambda, Alibaba Cloud FC)
- Runtime architecture and data persistence
- Operations, troubleshooting, and go-live checklist

### 1.1 API Artifacts

The repository includes importable API artifacts:

- `docs/api/openapi.yaml` (OpenAPI 3.0.3 source)
- `docs/api/openapi.json` (OpenAPI JSON export)
- `docs/api/postman_collection.json` (Postman Collection)

Recommended workflow:

1. Read this document to understand runtime and operational constraints.
2. Import `docs/api/openapi.yaml` or `docs/api/openapi.json` into your API tooling.
3. Use `docs/api/postman_collection.json` for integration smoke testing.

## 2. Architecture Overview

### 2.1 Execution Model

PicoClaw uses a **single-container, request-driven** model:

- No message polling or internal long-running scheduler loops.
- Each HTTP request triggers one processing cycle (chat or task).
- Claude Agent SDK `query()` is the core execution engine.
- MCP Server runs as a stdio child process managed by the SDK (not an in-process module).

### 2.2 Request Lifecycle

```
HTTP Request
      |
      v
  Express Router + Auth Middleware
      |
      |  1. Resolve/create conversation
      v
    SQLite (/tmp/messages.db)  <----+
      |                             |
      |  2. Invoke agent            |  4. MCP tools write back
      v                             |
  AgentEngine                       |
  (Claude Agent SDK query())        |
      |                             |
      |  3. Spawns subprocess       |
      v                             |
  MCP Server (stdio) -------->-----+
  - send_message
  - schedule_task
  - list/pause/cancel_task
      .
      .  5. After response
      v
  syncDatabaseToVolume()
  /tmp/messages.db  -->  /data/store/messages.db
```

### 2.3 Mounted Volumes

Default paths (overridable via environment variables):

| Path | Env Var | Purpose |
|------|---------|---------|
| `/data/memory` | `MEMORY_DIR` | CLAUDE.md persona, conversation archives, working directory |
| `/data/skills` | `SKILLS_DIR` | SKILL.md skill definitions |
| `/data/sessions` | `SESSIONS_DIR` | `.claude/` session state |
| `/data/store` | `STORE_DIR` | Persistent SQLite database |
| `/tmp/messages.db` | `LOCAL_DB_PATH` | Local runtime database (ephemeral) |

All four `/data/*` paths must be on persistent storage (EFS, NAS, or local volumes) for cross-request state to survive.

### 2.4 Cloud Storage Mount Scheme (OSS / EFS / NAS)

When deploying with cloud object storage or network-attached filesystems, map the user-specific and shared storage to PicoClaw volumes:

```
User-specific storage (per-user OSS bucket or subdirectory):
├── memory/         → mount to /data/memory    (persona, agent workspace)
│   ├── CLAUDE.md                              (user persona, required)
│   ├── skills/                                (user-created skills, auto-discovered)
│   ├── conversations/                         (archived transcripts, auto-created)
│   └── [agent-managed files]                  (no enforced structure)
├── store/          → mount to /data/store     (persistent SQLite)
│   └── messages.db
└── sessions/       → mount to /data/sessions  (SDK session state)
    └── .claude/
        ├── sessions/
        └── settings.json

Shared storage (global, read-only):
├── skills/         → mount to /data/skills    (organization-wide skills)
│   ├── add-pdf-reader/
│   ├── add-image-vision/
│   └── ...
└── default-persona/ → copy to /data/memory/CLAUDE.md on first boot
```

Docker mount example with cloud storage paths:

```bash
docker run --rm -it \
  -p 9000:9000 \
  -v /oss/users/${USER_ID}/memory:/data/memory \
  -v /oss/users/${USER_ID}/store:/data/store \
  -v /oss/users/${USER_ID}/sessions:/data/sessions \
  -v /oss/global/skills:/data/skills:ro \
  -e API_TOKEN=${GENERATED_TOKEN} \
  -e ANTHROPIC_BASE_URL=${API_BASE} \
  -e ANTHROPIC_API_KEY=${API_KEY} \
  picoclaw:latest
```

The `memory` directory does not enforce a subdirectory structure. The `conversations/` subdirectory is created on-demand by the PreCompact hook when context compaction occurs. The `skills/` subdirectory is auto-discovered for user-created skills.

## 3. Lifecycle & State

### 3.1 Conversation State

Conversations are tracked in the SQLite `conversations` table:

| Column | Purpose |
|--------|---------|
| `id` | Conversation identifier (e.g., `conv-abc123`) |
| `session_id` | Claude SDK session ID (for resume) |
| `last_assistant_uuid` | Last assistant message UUID (for `resumeSessionAt`) |
| `status` | `idle` or `running` |
| `message_count` | Total messages in conversation |

Behavior:

- `POST /chat` without `conversation_id`: creates a new conversation.
- `POST /chat` with `conversation_id`: resumes the existing conversation. Returns `404` if not found.
- Session resume uses `session_id` + `last_assistant_uuid` to restore SDK state across requests.

### 3.2 Task State

Scheduled tasks are tracked in the `scheduled_tasks` table:

| Field | Values |
|-------|--------|
| `schedule_type` | `cron`, `interval`, `once` |
| `context_mode` | `group` (shared conversation) or `isolated` (fresh each run) |
| `status` | `active`, `paused`, `completed` |

Key rules:

- `POST /task/check` executes at most **one** due task per call.
- `once` tasks set `next_run = null` and transition to `completed` after execution.
- `isolated` tasks create a temporary conversation per run to avoid foreign key violations.

### 3.3 Database Sync

The dual-database strategy optimizes for both performance and durability:

- **Runtime**: all reads/writes go to `/tmp/messages.db` (local filesystem, fast I/O).
- **After each HTTP response**: `wal_checkpoint(TRUNCATE)` flushes WAL, then file copy to `/data/store/messages.db`.
- **On shutdown** (`SIGTERM`, `SIGINT`, or `POST /control/stop`): final sync before process exit.

This avoids SQLite-on-NFS corruption risks while ensuring data survives container recycling.

### 3.4 Data Lifecycle & Automatic Cleanup

PicoClaw automatically prunes stale data during each database sync (after every HTTP response and on shutdown). Two cleanup policies run inside `cleanupStaleData()`:

| Policy | Env Var | Default | Behavior |
|--------|---------|---------|----------|
| Outbound message TTL | `OUTBOUND_TTL_DAYS` | `7` | Delivered outbound messages older than N days are deleted |
| Task run log retention | `TASK_LOG_RETENTION` | `100` | Per-task, only the most recent N run log entries are kept |

**When to tune these values:**

- **High-traffic deployments** with frequent `send_message` calls may accumulate outbound messages quickly. Reduce `OUTBOUND_TTL_DAYS` (e.g., `3`) to keep the database smaller.
- **Long-running deployments** with many recurring tasks can accumulate run logs. Reduce `TASK_LOG_RETENTION` (e.g., `50`) if storage is constrained, or increase it (e.g., `500`) if you need deeper task execution history for debugging.
- **Short-lived containers** (e.g., single-session Lambda) can safely leave defaults — cleanup runs automatically and the data volume is minimal.

**Configuration example:**

```bash
docker run ... \
  -e OUTBOUND_TTL_DAYS=3 \
  -e TASK_LOG_RETENTION=50 \
  picoclaw:latest
```

These settings only affect automatic cleanup. Undelivered outbound messages are never deleted by TTL. Active (non-delivered) data is always preserved.

### 3.5 SDK Version Alignment

| Package | Version | Notes |
|---------|---------|-------|
| `@anthropic-ai/claude-agent-sdk` | `0.2.34` | Core agent runtime |
| `@modelcontextprotocol/sdk` | `1.12.1` | MCP server framework |

Do not downgrade these packages. Upgrades should include compatibility regression testing.

## 4. Environment Variables

### 4.1 Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_BASE_URL` | Anthropic API base URL (default: `https://api.anthropic.com`). Set this when using a third-party API proxy or custom endpoint (e.g. `https://your-proxy.com/anthropic`). |
| `ANTHROPIC_API_KEY` | Claude API key (or equivalent OAuth token) |
| `API_TOKEN` | Bearer token for HTTP API authentication |

### 4.2 Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9000` | HTTP server port |
| `MAX_EXECUTION_MS` | `300000` | Agent execution timeout in ms (5 minutes) |
| `ASSISTANT_NAME` | `Pico` | Agent display name |
| `TZ` | System timezone | Timezone for cron expression parsing |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `STORE_DIR` | `/data/store` | Persistent database volume |
| `MEMORY_DIR` | `/data/memory` | Memory and persona volume |
| `SKILLS_DIR` | `/data/skills` | Skills volume |
| `SESSIONS_DIR` | `/data/sessions` | Session state volume |
| `LOCAL_DB_PATH` | `/tmp/messages.db` | Local runtime database path |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | Marker string for session completion |
| `PICOCLAW_MCP_SERVER_PATH` | `dist/mcp-server.js` | Custom MCP server executable path (legacy `NANOCLAW_MCP_SERVER_PATH` accepted as fallback) |
| `OUTBOUND_TTL_DAYS` | `7` | Days to keep delivered outbound messages before automatic cleanup |
| `TASK_LOG_RETENTION` | `100` | Maximum task run log entries retained per task (oldest pruned) |

## 5. Authentication & Request Tracking

All endpoints except `GET /health` require:

```http
Authorization: Bearer <API_TOKEN>
```

Error responses:

| Code | Condition |
|------|-----------|
| `401 Unauthorized` | Token missing or invalid |
| `500 Internal Server Error` | Server-side `API_TOKEN` not configured |

### 5.1 Request ID

Every response includes an `X-Request-ID` header for log correlation:

```http
X-Request-ID: req-a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

If the caller sends an `X-Request-ID` header, the same value is echoed back. Otherwise, a new `req-<UUID>` is generated. Use this to correlate API requests with server-side logs.

## 6. API Reference

Base URL: `http://localhost:9000` (or your deployment URL)

### 6.1 Health Check

`GET /health`

No authentication required.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "max_execution_ms": 300000,
  "database": {
    "ok": true,
    "conversations": 5,
    "tasks": 2
  },
  "volumes": {
    "memory": true,
    "skills": true,
    "sessions": true,
    "store": true
  }
}
```

`status` values:

| Value | Meaning |
|-------|---------|
| `ok` | All backing resources healthy |
| `degraded` | HTTP server is running but database or volumes are unhealthy |

The `database` field verifies SQLite connectivity and returns conversation/task counts. The `volumes` field checks writability of each `/data/*` mount directory (`skills` only checks existence since it may be read-only).

### 6.2 Send / Continue a Conversation

`POST /chat`

Request body:

```json
{
  "message": "What is 1 + 1?",
  "conversation_id": "conv-xxx",
  "sender": "user-1",
  "sender_name": "Alice",
  "stream": false,
  "max_execution_ms": 120000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message text |
| `conversation_id` | string | No | Existing conversation ID (creates new if omitted) |
| `sender` | string | No | Sender identifier (default: `user`) |
| `sender_name` | string | No | Display name (default: same as sender) |
| `stream` | boolean | No | Enable SSE streaming (default: `false`) |
| `max_execution_ms` | number | No | Per-request timeout, capped at server `MAX_EXECUTION_MS` |

Non-streaming response:

```json
{
  "status": "success",
  "conversation_id": "conv-0df6...",
  "message_id": "msg-3aaf...",
  "result": "2",
  "session_id": "3e49...",
  "duration_ms": 6701,
  "outbound_messages": [],
  "session_end_marker": "[[PICOCLAW_SESSION_END]]",
  "session_end_marker_detected": false
}
```

`status` values:

| Value | Meaning |
|-------|---------|
| `success` | Agent completed normally |
| `timeout` | Agent hit execution time limit (partial result may be available) |
| `error` | Agent encountered an error |

Session end fields:

- `session_end_marker`: the configured marker string the runtime looks for.
- `session_end_marker_detected`: `true` if the agent's response contains the marker, signaling the conversation is complete.

### 6.3 SSE Streaming

When `stream: true`, the response uses `Content-Type: text/event-stream`. Text is streamed per-token as the model generates it (via SDK `includePartialMessages`):

| Event | Data | When |
|-------|------|------|
| `start` | `{"conversation_id", "message_id"}` | Agent begins processing |
| `chunk` | `{"text": "..."}` | Incremental text output (per-token granularity) |
| `done` | Full response object | Agent finished |
| `error` | `{"error": "..."}` | Processing failed |

Example stream:

```text
event: start
data: {"conversation_id":"conv-...","message_id":"msg-..."}

event: chunk
data: {"text":"partial output"}

event: done
data: {"status":"success","conversation_id":"conv-...","session_end_marker":"[[PICOCLAW_SESSION_END]]","session_end_marker_detected":false}
```

### 6.4 List All Conversations

`GET /chat`

```json
{
  "conversations": [
    {
      "conversation_id": "conv-0df6...",
      "session_id": "3e49...",
      "message_count": 4,
      "last_activity": "2026-03-08T01:57:18.082Z",
      "status": "idle"
    }
  ]
}
```

### 6.5 Get Conversation Messages

`GET /chat/:conversation_id/messages`

```json
{
  "conversation_id": "conv-0df6...",
  "messages": [
    {
      "id": "msg-abc",
      "conversation_id": "conv-0df6...",
      "role": "user",
      "sender": "user",
      "sender_name": "Alice",
      "content": "Hello",
      "created_at": "2026-03-08T01:57:18.082Z"
    }
  ]
}
```

Returns `404` if the conversation does not exist.

### 6.6 Delete a Conversation

`DELETE /chat/:conversation_id`

Returns `204 No Content` on success. Deletes all associated messages, outbound messages, and tasks (CASCADE).

Returns `404` if the conversation does not exist. Returns `409` if the conversation is currently running.

### 6.7 Get Conversation Metadata

`GET /chat/:conversation_id`

```json
{
  "conversation_id": "conv-0df6...",
  "session_id": "3e49...",
  "message_count": 4,
  "last_activity": "2026-03-08T01:57:18.082Z",
  "status": "idle"
}
```

Returns `404` if the conversation does not exist.

### 6.8 Create a Scheduled Task

`POST /task`

```json
{
  "id": "daily-report",
  "prompt": "Generate the daily report",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "context_mode": "isolated",
  "conversation_id": "conv-xxx"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | Custom task ID (auto-generated if omitted) |
| `prompt` | string | Yes | Instruction for the agent |
| `schedule_type` | string | Yes | `cron`, `interval`, or `once` |
| `schedule_value` | string | Yes | Schedule expression (see below) |
| `context_mode` | string | No | `group` or `isolated` (default: `isolated`) |
| `conversation_id` | string | No | Target conversation (auto-created if omitted) |

Schedule value formats:

| Type | Format | Example |
|------|--------|---------|
| `cron` | 5-field cron expression | `0 9 * * 1-5` (weekdays at 9am) |
| `interval` | Milliseconds as string | `3600000` (every hour) |
| `once` | Local time string (no `Z` or timezone offset) | `2026-03-15T14:00:00` |

### 6.9 List All Tasks

`GET /tasks`

```json
{
  "tasks": [
    {
      "id": "daily-report",
      "conversation_id": "conv-xxx",
      "prompt": "...",
      "schedule_type": "cron",
      "schedule_value": "0 9 * * 1-5",
      "context_mode": "isolated",
      "next_run": "2026-03-09T01:00:00.000Z",
      "last_run": null,
      "last_result": null,
      "status": "active",
      "created_at": "2026-03-08T02:00:00.000Z"
    }
  ]
}
```

### 6.10 Update a Task

`PUT /task/:task_id`

Supports partial updates of: `prompt`, `schedule_type`, `schedule_value`, `context_mode`, `status`, `conversation_id`.

If `schedule_type` or `schedule_value` changes, `next_run` is recalculated automatically.

### 6.11 Delete a Task

`DELETE /task/:task_id`

Returns `204 No Content` on success.

### 6.12 Manually Trigger a Task

`POST /task/trigger`

```json
{
  "task_id": "daily-report"
}
```

Response:

```json
{
  "status": "success",
  "task_id": "daily-report",
  "result": "Report generated successfully.",
  "duration_ms": 4874,
  "next_run": null
}
```

### 6.13 Check and Execute Due Tasks

`POST /task/check`

No due tasks:

```json
{
  "checked": 0,
  "message": "No due tasks"
}
```

With due tasks:

```json
{
  "checked": 3,
  "executed": {
    "status": "success",
    "task_id": "task-1",
    "result": "...",
    "duration_ms": 3500,
    "next_run": "2026-03-08T02:10:00.000Z"
  },
  "remaining": 2
}
```

Each call executes at most **one** due task. Call repeatedly or increase external cron frequency for backlogs.

### 6.14 Reload Skills

`POST /admin/reload-skills`

Re-syncs skills from all three tiers (built-in, shared, user) to `.claude/skills/`.

```json
{
  "status": "reloaded",
  "skills": {
    "builtIn": ["agent-browser"],
    "shared": ["math-skill"],
    "user": ["custom-skill"],
    "effective": ["agent-browser", "custom-skill", "math-skill"]
  }
}
```

### 6.15 Get Skills Summary

`GET /admin/skills`

Returns the current skills from all three tiers.

### 6.16 Graceful Shutdown

`POST /control/stop`

Request body (optional):

```json
{
  "reason": "end-of-session"
}
```

Response:

```json
{
  "status": "stopping",
  "reason": "end-of-session",
  "message": "Shutdown accepted. The runtime will sync data and exit gracefully."
}
```

Typical caller flow:

1. Send messages via `POST /chat`.
2. Check `session_end_marker_detected` in each response.
3. If `true`, call `POST /control/stop` to trigger graceful shutdown (sync + exit).
4. Alternatively, the serverless platform sends `SIGTERM` — the same sync-and-exit sequence runs.

## 7. Deployment Guide

### 7.1 One-Click Script

The repository includes `picoclaw.sh` for automated setup:

```bash
./picoclaw.sh          # Full: env setup → build → docker run → smoke test
./picoclaw.sh up       # Build and start (skip smoke test)
./picoclaw.sh test     # Smoke test a running instance
./picoclaw.sh stop-api # Graceful stop via POST /control/stop
./picoclaw.sh logs     # Tail container logs
./picoclaw.sh down     # Docker stop
```

The script prompts for `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, generates an `API_TOKEN`, and writes `.env`.

### 7.2 Local Node.js

```bash
npm ci
npm run build
API_TOKEN=dev-token ANTHROPIC_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=sk-ant-xxx npm start
```

### 7.3 Local Docker

The Dockerfile uses a multi-stage build — TypeScript is compiled inside Docker, so no local Node.js is needed.

Build:

```bash
docker build --platform linux/amd64 -t picoclaw:latest .
```

Run:

```bash
docker run --rm -it \
  -p 9000:9000 \
  -e API_TOKEN=dev-token \
  -e ANTHROPIC_BASE_URL=https://api.anthropic.com \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -v $(pwd)/dev-data/memory:/data/memory \
  -v $(pwd)/dev-data/skills:/data/skills \
  -v $(pwd)/dev-data/store:/data/store \
  -v $(pwd)/dev-data/sessions:/data/sessions \
  picoclaw:latest
```

Or use the Makefile:

```bash
make docker-build
make docker-run
```

### 7.4 Docker Compose

```bash
# Copy .env.example or create .env with ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, and API_TOKEN
docker compose up --build
```

### 7.5 AWS Lambda (Container Image)

**Recommended configuration:**

| Setting | Value |
|---------|-------|
| Runtime | Container Image |
| Memory | 4096 MB minimum |
| Timeout | `MAX_EXECUTION_MS + 30s` (e.g., 330s for 5-min agent) |
| Storage | EFS mounted at `/data` |

Build the Lambda-adapted image:

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```

The `ENABLE_LAMBDA_ADAPTER=true` build arg installs the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) which proxies Lambda invoke events to the Express HTTP server.

**Task scheduling:** Use Amazon EventBridge Scheduler to invoke `POST /task/check` every minute via the Lambda function URL or API Gateway.

**Environment variables:** Inject `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `API_TOKEN` via Lambda environment variables or AWS Secrets Manager.

### 7.6 Alibaba Cloud Function Compute (FC)

**Recommended configuration:**

| Setting | Value |
|---------|-------|
| Runtime | Custom Container |
| Listening port | `9000` |
| Storage | NAS mounted at `/data` |
| Timeout | Greater than `MAX_EXECUTION_MS` |

**Task scheduling:** Configure a timer trigger to call `POST /task/check` at the desired frequency.

## 8. Operations

### 8.1 Security

- Inject `API_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_API_KEY` via secret management systems — never bake into the image.
- Place PicoClaw behind an API Gateway or WAF for network-level protection.
- Enable request-level audit logging and rate limiting at the gateway layer.
- See `docs/SECURITY.md` for the full trust model.

### 8.2 Concurrency

- The runtime uses SQLite on a local path (`/tmp/messages.db`). SQLite does not support multi-writer concurrency across processes.
- Cloud platform concurrency controls should limit to **one active instance** per conversation scope.
- For strong consistency requirements, implement idempotency and retry logic at the gateway layer.

### 8.3 Scheduled Tasks

- PicoClaw has **no internal scheduler**. Task execution depends entirely on external cron calling `POST /task/check`.
- Each call executes at most one due task. For high-frequency task needs, trigger every 1 minute.
- Monitor the `remaining` field in `/task/check` responses to detect backlog buildup.

### 8.4 Shutdown Strategy

| Method | Trigger | Use Case |
|--------|---------|----------|
| `POST /control/stop` | API call | Programmatic shutdown after session end marker detected |
| `SIGTERM` | Platform signal | Serverless container recycling |
| `SIGINT` | Ctrl+C | Local development |

All three paths execute the same sequence: `syncDatabaseToVolume()` → `closeDatabase()` → process exit.

### 8.5 Backup & Recovery

Recommended backup targets:

| Path | Priority | Contains |
|------|----------|----------|
| `/data/store/messages.db` | Critical | All conversations, messages, tasks |
| `/data/sessions/.claude` | High | Claude session state for resume |
| `/data/memory` | High | Persona, archives, global memory |
| `/data/skills` | Medium | Skill definitions (can be redeployed) |

On restore, ensure version compatibility and restore `store` + `sessions` together for consistent session resume.

### 8.6 Logging & Monitoring

PicoClaw uses structured JSON logging via `pino`.

Recommended metrics to monitor:

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Request latency | HTTP response time | P95 > `MAX_EXECUTION_MS` |
| `status=timeout` rate | Chat response `status` field | > 10% |
| `status=error` rate | Chat response `status` field | > 5% |
| Task backlog | `/task/check` `remaining` field | Sustained > 0 |
| `401` rate | HTTP status codes | Spike detection |

## 9. Troubleshooting

### 9.1 `401 Unauthorized`

- Verify the `Authorization: Bearer <token>` header is present.
- Confirm the token matches the server's `API_TOKEN` environment variable exactly.

### 9.2 `conversation_id not found` (404)

- The specified `conversation_id` does not exist in the database.
- Omit `conversation_id` to create a new conversation, or use an existing ID.

### 9.3 `MCP server not found ... dist/mcp-server.js`

- For local Node.js: TypeScript has not been compiled. Run `npm run build` before starting.
- For Docker: the multi-stage build compiles TypeScript during image creation. Rebuild the image if source changed.

### 9.4 `schedule_value` validation errors

| Type | Requirement |
|------|------------|
| `interval` | Positive integer in milliseconds (as a string) |
| `cron` | Valid 5-field cron expression |
| `once` | Local timestamp string without `Z` or timezone offset |

### 9.5 Data loss after forced termination

If the container is killed before `syncDatabaseToVolume()` completes, the last request's data may be lost.

Mitigations:

- Set platform timeout with sufficient buffer beyond `MAX_EXECUTION_MS`.
- The runtime syncs after every HTTP response, so only the in-flight request is at risk.

### 9.6 Session end marker not detected

- Check that the agent's response text actually contains `[[PICOCLAW_SESSION_END]]`.
- The marker is configurable via `SESSION_END_MARKER` env var.
- The persona (CLAUDE.md) must instruct the agent when to emit this marker.

## 10. Go-Live Checklist

- [ ] `GET /health` returns `200`
- [ ] `POST /chat` creates a new conversation successfully
- [ ] `POST /chat` with `conversation_id` resumes correctly (multi-turn)
- [ ] `GET /chat` lists conversations
- [ ] `GET /chat/:id/messages` returns message history
- [ ] `DELETE /chat/:id` deletes conversation (204)
- [ ] `session_end_marker_detected` triggers as expected
- [ ] `POST /task` + `POST /task/check` execute scheduled tasks
- [ ] `POST /admin/reload-skills` reloads skills from all tiers
- [ ] `GET /admin/skills` returns skills summary
- [ ] `POST /control/stop` syncs data and exits cleanly
- [ ] All four `/data/*` volumes are mounted and writable
- [ ] External cron is configured to call `POST /task/check`
- [ ] Logging, alerting, and rate limiting are configured
- [ ] Secrets (`API_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`) are injected via secret manager, not in image or repository
- [ ] Concurrency controls limit to one active instance per conversation scope
