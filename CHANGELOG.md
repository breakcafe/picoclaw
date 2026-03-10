# Changelog

All notable changes to PicoClaw will be documented in this file.

## [Unreleased]

### Added
- Developer documentation: API integration guide, Skills & Persona authoring guide
- Rewritten SECURITY.md for HTTP API trust model
- Cleaned up legacy NanoClaw docs from `docs/` directory

## [1.2.12] — 2026-03-09

### Added
- `bump-version` CI workflow with dry-run dispatch for safe validation

### Changed
- Updated token count badge to 24.6k tokens (12% of context window)
- Removed GitHub App secret dependency from main CI workflows

## [1.2.11] — 2026-03-08

### Added
- `MessageStream` async-iterable prompt input for Agent Teams compatibility (adopted from Opus review)
- Explicit temporary conversation row for `isolated` tasks, preventing `send_message` FK write failures

### Fixed
- Hardened isolated task execution to avoid orphaned outbound messages

## [1.2.10] — 2026-03-08

### Added
- `docs/nanoclaw-latest-alignment.md` documenting decisions on what to adopt vs skip from upstream NanoClaw

### Changed
- Aligned SDK version baseline documentation with upstream NanoClaw v1.2.x

## [1.2.9] — 2026-03-07

### Changed
- Renamed package from `nanoclaw` to `picoclaw` across package.json, branding, and runtime output
- Version baseline set to 1.2.9 (matching upstream NanoClaw at fork point)

### Added
- `picoclaw.sh` one-click launcher: env setup, build, Docker run, smoke test
- `POST /control/stop` graceful shutdown API with data sync
- Configurable `LOCAL_DB_PATH` and `SESSIONS_DIR` for flexible deployment
- `entrypoint.sh` for Docker: session symlink, settings bootstrap, skill sync

## [1.2.8] — 2026-03-07

### Added
- OpenAPI 3.0.3 specification (`docs/api/openapi.yaml`, `docs/api/openapi.json`)
- Postman collection for API smoke testing (`docs/api/postman_collection.json`)
- `docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md` — full operations manual (Chinese)

## [1.2.7] — 2026-03-06

### Added
- Docker container runtime with multi-stage build (node:22-slim + Chromium + Python 3)
- `Makefile` with build, run, test, and e2e targets
- `docker-compose.yml` for local development with volume mounts
- AWS Lambda Web Adapter support via `ENABLE_LAMBDA_ADAPTER` build arg

## [1.2.6] — 2026-03-06

### Changed
- **Architecture rewrite**: from multi-channel host orchestrator to serverless HTTP API
- Removed `container-runner.ts`, `container-runtime.ts`, `ipc.ts`, `group-queue.ts`
- Replaced channel adapters (Telegram, WhatsApp, Slack) with unified HTTP endpoints
- Agent execution moved from Docker child containers to in-process `AgentEngine`
- IPC file system replaced with shared SQLite database
- MCP Server simplified: reads/writes SQLite directly instead of IPC files

### Added
- `src/agent-engine.ts` — Claude Agent SDK wrapper with timeout, hooks, session resume
- `src/server.ts` — Express HTTP server with auth middleware
- `src/routes/chat.ts` — multi-turn conversation with SSE streaming
- `src/routes/task.ts` — scheduled task CRUD + trigger + check
- `src/routes/control.ts` — graceful shutdown endpoint
- `src/db.ts` — SQLite schema with dual-path sync (local `/tmp` + persistent volume)
- `src/mcp-server.ts` — MCP tools: send_message, schedule_task, list/pause/resume/cancel/update_task
- `src/skills.ts` — skill directory sync and Claude settings bootstrap
- Bearer token authentication middleware
- Pre-compact hook for conversation archival
- Session-end marker detection (`[[PICOCLAW_SESSION_END]]`)
- `session_id` and `last_assistant_uuid` tracking for cross-request session resume

---

## Pre-Fork History (NanoClaw)

PicoClaw was forked from [NanoClaw](https://github.com/qwibitai/nanoclaw) v1.2.0. Changes before the fork point are documented in the NanoClaw repository.
