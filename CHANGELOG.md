# Changelog

All notable changes to PicoClaw will be documented in this file.

## [1.2.23]

### Changed

- **Dirty-flag DB sync**: `syncDatabaseToVolume()` now tracks a dirty flag and skips
  WAL checkpoint + file copy when no writes occurred since the last sync. Read-only
  requests (health probes, `GET /chat`, `GET /tasks`, `POST /task/check` with no due
  tasks) no longer trigger sync I/O. Benchmarked at 95-99% reduction in sync operations
  for typical serverless workloads. Shutdown path uses `force=true` to guarantee a final
  sync regardless of dirty state.
- **Throttled cleanup**: `cleanupStaleData()` (expired outbound message deletion, task
  run log pruning) is throttled to run at most once per `CLEANUP_INTERVAL_S` (default 60s)
  instead of on every sync. Set to `0` to restore per-sync behavior.
- **SQLite pragma tuning**: `synchronous=NORMAL` (safe with WAL mode and dual-DB sync
  strategy), 8 MB page cache (`cache_size=-8000`), `temp_store=MEMORY`. Reduces fsync
  overhead and keeps more pages in memory.
- **Batched post-agent writes**: New `finalizeConversation()` in `db.ts` combines
  assistant message INSERT + session metadata UPDATE + conversation status reset into a
  single transaction (was 3 separate DB calls per chat response).

### Added

- `CLEANUP_INTERVAL_S` environment variable (default `60`). Controls minimum interval
  between cleanup runs during database sync.

## [1.2.22]

### Changed

- **Single-layer skill sync**: Removed duplicate skill sync from `entrypoint.sh` (~45 lines).
  Skill sync (three-tier merge + runtime skill persist) now runs once at Node.js startup
  via `syncSkills()`. Halves startup I/O operations; saves 1–5s on NAS/OSS mounts.

## [1.2.21]

### Changed

- **In-process MCP server**: The built-in `picoclaw` MCP server now runs in-process
  using the SDK's `createSdkMcpServer()` (`type: 'sdk'`) instead of spawning a stdio
  subprocess on every request. A/B testing on SDK 0.2.86 shows ~40ms improvement
  per request (stdio 529ms → in-process 490ms sdkInit). The stdio variant
  (`src/mcp-server.ts`) is retained for backward compatibility and can be re-enabled
  via `PICOCLAW_MCP_SERVER_PATH`.

### Added

- **V8 compile cache**: `NODE_COMPILE_CACHE` is set in `entrypoint.sh` and `Dockerfile`
  to cache bytecode for the 11.5 MB `cli.js` file, reducing per-request CLI subprocess
  parse time by ~140ms once warm (Node.js 22+).
- **Host-side filesystem caching**: `loadOrgClaudeMd()` and `discoverAdditionalDirectories()`
  results are cached across requests and invalidated on `POST /admin/reload-skills`.
- **Shared task utilities**: `src/task-utils.ts` extracts `computeNextRun()` and
  `validateTaskOwnership()` as shared functions used by both the in-process and stdio
  MCP server implementations.

## [1.2.20]

### Changed

- **SDK upgrade**: `@anthropic-ai/claude-agent-sdk` 0.2.74 → 0.2.86, `@modelcontextprotocol/sdk`
  1.27.1 → 1.28.0. Agent SDK adds new hook events (`StopFailure`, `PostCompact`, `TaskCreated`,
  `CwdChanged`, `FileChanged`), new query options (`taskBudget`), new message types
  (`SDKAPIRetryMessage`), and new query methods (`getContextUsage()`, `seedReadState()`).
  MCP SDK adds stricter input schema validation and OAuth fixes. No breaking changes for
  PicoClaw — all existing code is backward compatible.

### Fixed

- **MCP server loading conflict**: Claude Code CLI rejects `--mcp-config` when
  `/etc/claude-code/managed-mcp.json` (enterprise MCP config) is present, which
  broke the built-in `picoclaw` MCP server in Docker deployments with `ORG_DIR`.
  Fix: load `managed-mcp.json` programmatically and merge all MCP servers through
  `query()` `mcpServers` option instead of CLI auto-discovery.

### Added

- **Three-way MCP server merge**: org-managed (from `managed-mcp.json`) →
  built-in `picoclaw` (protected, cannot be overridden) → per-request (highest
  priority, can override managed same-name servers).
- **MCP validation warnings**: Chat responses include an optional `warnings`
  array when per-request MCP servers have issues (reserved name `picoclaw`,
  invalid configs). Previously, invalid entries were silently dropped.
- New `src/managed-mcp.ts` module for reading and caching managed MCP configs.

### Changed

- `entrypoint.sh` no longer copies `managed-mcp.json` to `/etc/claude-code/`.
  Org MCP servers are now loaded programmatically by the Node.js process.
- `validateMcpServers()` returns `{ servers, warnings }` instead of just servers.
- MCP debug log now includes `source` field (`built-in`, `org-managed`, `per-request`).
- Reserved name `picoclaw` is now rejected at load time in both managed-mcp.json
  and per-request `mcp_servers` (with descriptive warning in each case).
- MCP source detection in debug logs correctly identifies per-request servers
  that override org-managed servers of the same name.
- Version bumped to 1.2.20.

## [1.2.19]

### Added

- **Agent usage metrics**: Chat and task responses now include an optional `usage`
  object with `inputTokens`, `outputTokens`, `totalCostUsd`, `numTurns`, and
  `durationApiMs` extracted from the Claude Agent SDK result message.
- **SDK debug logging**: New `SDK_LOG_LEVEL` env var (`off` by default, set to
  `debug` to pipe Claude Agent SDK stderr output through pino at debug level).
- **Startup diagnostics**: Boot sequence logs mounted volume paths, persona file
  presence (org/user CLAUDE.md, SYSTEM_PROMPT_OVERRIDE flag), model config, and
  SDK log level as a single structured log entry.
- **MCP debug logging**: At debug level, logs configured MCP servers (name and
  transport type) before each `query()` call, and logs the full tool list and MCP
  server connection status from the SDK `system/init` message after session
  initialization. Enable with `LOG_LEVEL=debug`.
- **Enhanced request logging**: Chat requests log conversation ID, stream mode, and
  isNew flag at request start; log token usage and cost at request completion.

### Changed

- `AgentRunOutput` interface extended with optional `usage` field.
- `TaskExecutionResult` interface extended with optional `usage` field.
- OpenAPI spec updated with `usage` object in `ChatResponse` schema.
- Version bumped to 1.2.19.

## [1.2.18]

### Fixed

- **MCP zod v4 incompatibility**: Built-in MCP tools with parameters (`send_message`,
  `schedule_task`, etc.) failed at runtime with `keyValidator._parse is not a function`.
  Root cause: `@modelcontextprotocol/sdk@1.12.1` internally depends on zod v3 and calls
  `_parse()` on schema instances, but the project's `zod@4.3.6` produces v4 schemas that
  lack this method. Fix: upgrade `@modelcontextprotocol/sdk` from 1.12.1 to 1.27.1, which
  supports `zod ^3.25 || ^4.0` natively.
- **`context_mode` default inconsistency**: MCP `schedule_task` tool defaulted `context_mode`
  to `group`, while the HTTP `POST /task` endpoint, database schema, and all documentation
  default to `isolated`. Aligned MCP tool default to `isolated`.

### Changed

- **MCP SDK upgrade**: `@modelcontextprotocol/sdk` 1.12.1 → 1.27.1.
- Version bumped to 1.2.18.

## [1.2.17]

### Added

- **Auth-free mode**: When `API_TOKEN` is not set, authentication is disabled — all
  endpoints are accessible without a Bearer token. Warning logged at startup.
- **Model selection**: `CLAUDE_MODEL` and `CLAUDE_FALLBACK_MODEL` env vars. Per-request
  `model` parameter in `POST /chat` overrides env var. Actual model returned in response.
- **Version badge auto-sync**: Pre-commit hook updates README badge from `package.json`.

### Changed

- **SDK upgrade**: `@anthropic-ai/claude-agent-sdk` 0.2.34 → 0.2.74. Memory leak fix,
  HTTP MCP transport fix, session persistence fix, Sonnet 4.6 model support.
- `API_TOKEN` is no longer required. When unset, auth middleware passes all requests.

## [1.2.16]

### Added

- **GHCR publishing**: Docker images published to `ghcr.io/breakcafe/picoclaw` with
  branch-aware tags. New Makefile targets: `ghcr-build`, `ghcr-push`, `ghcr-release`.
- **Build metadata**: `GET /health` includes `commit` and `build_time`.
  Every HTTP response includes `X-Build-Version` and `X-Build-Commit` headers.
- **Per-request structured logging**: method, URL, status code, duration, request ID.
- **Docker build args**: `BUILD_VERSION`, `BUILD_COMMIT`, `BUILD_TIME` injected at
  build time. `APP_VERSION` defaults to `package.json` version.
- **Org directory (`ORG_DIR`)**: single env var + read-only mount consolidates org
  persona, org skills, and managed MCP servers into one directory.
- **Dynamic MCP server support**: `POST /chat` accepts `mcp_servers` field for
  per-request MCP server configuration (HTTP, SSE, stdio transports).
- `.dockerignore` for faster build context transfer.
- Developer documentation: API integration guide, Skills & Persona authoring guide,
  rewritten SECURITY.md for HTTP API trust model.

### Changed

- **Volume consolidation**: removed `SESSIONS_DIR`. SDK session state (`.claude/`)
  now lives inside `MEMORY_DIR`, reducing deployment from 4 volumes to 3.
- **Skill merge strategy**: user skills are now additive only — cannot override
  org or built-in skills of the same name.
- **Terminology**: "global persona" → "org persona", "shared skills" → "org skills".
- Dockerfile converted to multi-stage build: no local Node.js required for image builds.

### Removed

- `/data/memory/global/CLAUDE.md` path convention (NanoClaw legacy).

## [1.2.14]

### Added

- **`ANTHROPIC_BASE_URL` as first-class config**: set for third-party API proxies.

## [1.2.13]

### Changed

- Documentation overhaul: CLAUDE.md aligned with Claude Code conventions,
  deployment guide rewritten in English, design rationale added.
- API specs moved to `docs/api/`, legacy NanoClaw docs cleaned up.

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
- Configurable `LOCAL_DB_PATH` for flexible deployment
- `entrypoint.sh` for Docker: session symlink, settings bootstrap, directory setup

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
