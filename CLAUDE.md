# PicoClaw

Serverless-first Claude Agent runtime. HTTP API for conversations and scheduled tasks.
Forked from NanoClaw — no Docker child containers, no channel adapters.

## Code Style

- ESM modules with explicit `.js` extensions in imports: `import { foo } from './bar.js'`
- Single quotes, 2-space indentation (Prettier enforced, see `.prettierrc`)
- Named exports only, no default exports
- TypeScript strict mode; interfaces for data types (not type aliases)
- File naming: `kebab-case.ts`, tests colocated as `kebab-case.test.ts`
- Logger: `logger.info({ context }, 'message')` — structured pino, context object first
- Route pattern: factory function returning `Router` (see `src/routes/health.ts` for minimal example)

## Development Commands

```bash
npm run build              # tsc compile to dist/
npm run typecheck          # type check only (no emit)
npm test                   # run all tests (vitest)
npx vitest run src/db.test.ts   # run single test file
npm run dev                # dev mode with tsx (no build needed)
npm run format:check       # check formatting
npm run format:fix         # fix formatting (also runs on pre-commit hook)
```

Full tooling reference: `make help` shows all Makefile targets.

## Docker Workflow

```bash
./picoclaw.sh              # one-click: env setup → build → docker run → smoke test
./picoclaw.sh up           # build and start (no smoke test)
./picoclaw.sh test         # smoke test running service
./picoclaw.sh stop-api     # graceful stop via POST /control/stop
./picoclaw.sh down         # docker stop
./picoclaw.sh logs         # tail container logs
```

Alternatively: `make docker-build && make docker-run` for manual control.

## Architecture

```
src/index.ts          → process boot, directory init, shutdown signals
src/server.ts         → Express app: middleware → healthRoutes → authMiddleware → chat/task/control
src/routes/chat.ts    → POST /chat (SSE streaming), GET /chat/:id
src/routes/task.ts    → task CRUD + POST /task/trigger + POST /task/check
src/routes/control.ts → POST /control/stop (graceful shutdown)
src/agent-engine.ts   → Claude Agent SDK query() wrapper, hooks, timeout via AbortController
src/mcp-server.ts     → MCP tools (send_message, schedule_task, etc.) backed by SQLite
src/db.ts             → SQLite schema, CRUD operations, dual-path sync
src/skills.ts         → skill directory sync + .claude/settings.json bootstrap
src/config.ts         → all env var defaults
src/types.ts          → shared interfaces (Conversation, ScheduledTask, etc.)
```

### Request lifecycle

1. HTTP hits Express router → `authMiddleware` validates Bearer token
2. Route handler resolves/creates conversation in SQLite
3. `AgentEngine.run()` wraps prompt in `MessageStream`, calls `query()`
4. SDK spawns CLI subprocess → CLI spawns MCP Server (stdio)
5. Agent executes tools; MCP tools read/write same SQLite via `NANOCLAW_DB_PATH`
6. `query()` yields `system/init` (session_id), `assistant` (uuid), `result` messages
7. Route stores `session_id` + `last_assistant_uuid` for next resume
8. `syncDatabaseToVolume()` runs after response completes

### Database schema (5 tables in `src/db.ts`)

- `conversations` — id, session_id, last_assistant_uuid, status (idle/running), message_count
- `messages` — id, conversation_id (FK), role, sender, content, created_at
- `outbound_messages` — queued messages from MCP `send_message`, delivered flag
- `scheduled_tasks` — id, conversation_id (FK), prompt, schedule_type/value, context_mode, next_run, status
- `task_run_logs` — task_id (FK), run_at, duration_ms, status, result, error

### MCP tools (defined in `src/mcp-server.ts`)

The MCP server runs as a stdio subprocess. Tools share the SQLite DB:

- `send_message` — queue message for HTTP caller during agent execution
- `schedule_task` — create cron/interval/once task
- `list_tasks` — list tasks (main session: all; non-main: own conversation only)
- `pause_task` / `resume_task` — pause/resume with ownership check
- `cancel_task` — delete task with ownership check
- `update_task` — modify prompt, schedule, context_mode

### Volume mount semantics

| Mount | Runtime access | Agent `cwd` | Purpose |
|-------|---------------|-------------|---------|
| `/data/memory` | Read/Write | **Yes** (set as cwd) | CLAUDE.md persona, conversation archives, global memory |
| `/data/skills` | Read-only sync | No | SKILL.md definitions → synced to `.claude/skills/` at startup |
| `/data/sessions` | Read/Write | No | `.claude/` session state for SDK resume |
| `/data/store` | Write (sync target) | No | Persistent copy of SQLite DB |
| `/tmp` | Read/Write | No | Local runtime DB (ephemeral, fast) |

### Adding a new route

1. Create `src/routes/myroute.ts` with `export function myRoutes(): Router`
2. Mount in `src/server.ts` after `authMiddleware` (or before, if no auth needed)
3. Add test in `src/routes/myroute.test.ts` using supertest (see `server.test.ts` for pattern)

### Adding an MCP tool

1. Add tool definition in `src/mcp-server.ts` under the `server.tool()` section
2. Use `z` (zod) for input validation
3. Read/write via the shared SQLite `db` instance
4. Tool is auto-discovered by agent as `mcp__picoclaw__<tool_name>`

## Non-Negotiable Principles

1. **Memory and conversation history are core** — never treat as optional. Cross-request
   personalization depends on persistent mounted paths.
2. **Persistent data model** — `MEMORY_DIR`, `STORE_DIR`, `SESSIONS_DIR`, `SKILLS_DIR`
   must all be preserved on mounted volumes.
3. **Graceful stop must sync data** — both `POST /control/stop` and `SIGTERM`/`SIGINT`
   trigger `syncDatabaseToVolume()` → `closeDatabase()` → exit.
4. **SDK version alignment** — `@anthropic-ai/claude-agent-sdk`: `0.2.34`,
   `@modelcontextprotocol/sdk`: `1.12.1`. Do not downgrade.
5. **Dual-DB sync is the only safe write path** — never write directly to
   `/data/store/messages.db`. Always operate on `/tmp/messages.db` and let sync copy it.

## Key Environment Variables

| Variable | Default | Code location |
|----------|---------|---------------|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Used by SDK internally; set for third-party API proxies |
| `ANTHROPIC_API_KEY` | (required) | Used by SDK internally |
| `API_TOKEN` | (required) | `src/config.ts` → auth middleware |
| `PORT` | `9000` | `src/config.ts` |
| `MAX_EXECUTION_MS` | `300000` | `src/config.ts` → AbortController timeout |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | `src/config.ts` → chat response |
| `NANOCLAW_DB_PATH` | `/tmp/messages.db` | MCP server env var (set by agent-engine) |
| `NANOCLAW_CONVERSATION_ID` | per-request | MCP server env var (set by agent-engine) |
| `NANOCLAW_IS_MAIN` | `1` | MCP server env var — enables cross-conversation task management |

## Common Gotchas

- **ESM `.js` in imports**: TypeScript compiles `.ts` → `.js` but import paths must already
  say `.js`. Forgetting this causes runtime `ERR_MODULE_NOT_FOUND`.
- **MCP server is a subprocess**: `src/mcp-server.ts` runs as a stdio child process spawned
  by the SDK, not as part of the main Express server. It shares the SQLite DB via
  `NANOCLAW_DB_PATH` env var. You cannot import it directly.
- **Dual-DB sync**: Runtime operates on `/tmp/messages.db` (fast local). Every HTTP response
  triggers `syncDatabaseToVolume()` which does `wal_checkpoint(TRUNCATE)` + file copy to
  `STORE_DIR`. Never write directly to the volume path.
- **Pre-compact hook**: `agent-engine.ts` archives transcripts to
  `/data/memory/conversations/` when Claude compacts context. This creates markdown files
  from NDJSON session data.
- **MessageStream wrapping**: Prompts are wrapped in an `AsyncIterable` (not passed as strings)
  to prevent the SDK from prematurely closing stdin and killing subagents. See
  `MessageStream` class in `agent-engine.ts`.
- **Isolated task conversations**: When `context_mode=isolated`, the MCP server calls
  `ensureConversationExists()` before creating a task to avoid FK constraint violations.
- **`format` vs `format:fix`**: Both run Prettier write. The pre-commit hook calls `format:fix`.
  Use `format:check` to verify without modifying.

## Change Guardrails

After any code change, verify:

```bash
npm run build && npm test           # must pass
npm run format:check                # must pass
```

Also check:
- OpenAPI spec (`docs/api/openapi.yaml`) updated if API contract changed
- `CHANGELOG.md` updated for user-visible changes
- Stop path still syncs data and exits cleanly

## Docs

- @docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md — full operations and deployment manual
- @docs/API_INTEGRATION_GUIDE.md — downstream HTTP API integration guide
- @docs/SKILLS_AND_PERSONA_GUIDE.md — skill authoring and persona configuration
- @docs/SECURITY.md — HTTP API trust model and deployment hardening
- @docs/DESIGN_RATIONALE.md — architectural decisions and first-principles reasoning
- @docs/SDK_DEEP_DIVE.md — Claude Agent SDK internals (query, session resume, hooks)
- `docs/api/openapi.yaml` / `openapi.json` — API specification (validated by `src/openapi.test.ts`)
- `docs/api/postman_collection.json` — API smoke testing collection
