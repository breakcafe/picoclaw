# Changelog

All notable changes to PicoClaw will be documented in this file.

## [Unreleased]

### Added
- **Build metadata**: `GET /health` now includes `commit` (git short hash) and `build_time`
  (ISO 8601 UTC) fields. Every HTTP response includes `X-Build-Version` and `X-Build-Commit`
  headers for identifying the running build.
- **Per-request structured logging**: every HTTP request is logged with method, URL, status
  code, duration, and request ID via pino structured output.
- **Docker build args**: `BUILD_VERSION`, `BUILD_COMMIT`, and `BUILD_TIME` are injected at
  image build time by Makefile, `picoclaw.sh`, and `scripts/e2e-test.sh`. `APP_VERSION`
  defaults to `package.json` version instead of hardcoded `1.0.0` in Docker builds.
- **Org directory (`ORG_DIR`)**: single env var + read-only mount consolidates org
  persona (`CLAUDE.md`), org skills (`skills/`), and managed MCP servers
  (`managed-mcp.json`) into one directory. Replaces the previous
  `/data/memory/global/CLAUDE.md` convention.
- **Org MCP servers**: when `$ORG_DIR/managed-mcp.json` exists, it is copied to
  `/etc/claude-code/managed-mcp.json` at startup for Claude Code CLI auto-discovery.
- **Dynamic MCP server support**: `POST /chat` accepts `mcp_servers` field for
  per-request MCP server configuration (HTTP, SSE, and stdio transports).
  Servers are merged with the built-in picoclaw MCP server and their tools are
  automatically added to the agent's allowedTools list.
- `.dockerignore` for faster build context transfer
- Developer documentation: API integration guide, Skills & Persona authoring guide
- Rewritten SECURITY.md for HTTP API trust model
- Cleaned up legacy NanoClaw docs from `docs/` directory

### Changed
- **Skill merge strategy**: user skills (`/data/memory/skills/`) are now additive
  only — they supplement org and built-in skills but cannot override same-name
  skills. Priority: built-in → org (authoritative) → user (additive).
- **Terminology**: "global persona" → "org persona", "shared skills" → "org skills"
  throughout code and documentation.
- `SKILLS_DIR` default changes when `ORG_DIR` is set: derives from `$ORG_DIR/skills`
  instead of fixed `/data/skills`. Explicit `SKILLS_DIR` env var still overrides.
- `loadGlobalClaudeMd()` renamed to `loadOrgClaudeMd()` in `agent-engine.ts`.
- Skills API response field renamed: `shared` → `org` in `GET /admin/skills` and
  `POST /admin/reload-skills`.
- Dockerfile converted to multi-stage build: TypeScript compiles inside Docker,
  no local Node.js required for image builds
- Makefile `docker-build` no longer depends on local `build-ts` target
- `picoclaw.sh` build step no longer requires local `npm run build`

### Removed
- `/data/memory/global/CLAUDE.md` path convention (NanoClaw legacy, never used
  in PicoClaw production deployments). Use `$ORG_DIR/CLAUDE.md` instead.

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
