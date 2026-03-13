# PicoClaw Configuration Reference

Quick-reference for all configuration surfaces. For detailed explanations, see the linked docs.

## 1. Environment Variables

### Required

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key (scrubbed from agent Bash environment) |
| `API_TOKEN` | Bearer token for HTTP API authentication |

### Runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_BASE_URL` | _(empty; SDK uses `api.anthropic.com`)_ | API proxy URL. Only needed for third-party proxies. |
| `PORT` | `9000` | HTTP server port |
| `MAX_EXECUTION_MS` | `300000` | Agent execution timeout (ms) |
| `ASSISTANT_NAME` | `Pico` | Display name in messages and transcript archives |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | Agent emits this to signal conversation complete |
| `SYSTEM_PROMPT_OVERRIDE` | _(empty)_ | Replaces Claude Code preset + org CLAUDE.md entirely |
| `LOG_LEVEL` | `info` | Pino log level (`debug` / `info` / `warn` / `error`) |
| `TZ` | System timezone | Timezone for cron expressions |

### Paths

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORY_DIR` | `/data/memory` | Agent cwd, persona, `.claude/` session state |
| `STORE_DIR` | `/data/store` | Persistent SQLite sync target |
| `ORG_DIR` | _(empty)_ | Org resources (CLAUDE.md, skills/, managed-mcp.json); read-only |
| `SKILLS_DIR` | `$ORG_DIR/skills` or `/data/skills` | Org skills directory |
| `BUILT_IN_SKILLS_DIR` | `/app/built-in-skills` | Built-in skills (Docker image internal) |
| `LOCAL_DB_PATH` | `/tmp/messages.db` | Ephemeral runtime SQLite |

### Cleanup

| Variable | Default | Purpose |
|----------|---------|---------|
| `OUTBOUND_TTL_DAYS` | `7` | Days to keep delivered outbound messages |
| `TASK_LOG_RETENTION` | `100` | Max run logs per task |

### MCP Subprocess (set by agent-engine, not user-facing)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PICOCLAW_DB_PATH` | `/tmp/messages.db` | Shared SQLite path for MCP tools |
| `PICOCLAW_CONVERSATION_ID` | per-request | Current conversation scope |
| `PICOCLAW_IS_MAIN` | `1` | Enables cross-conversation task management |
| `PICOCLAW_MCP_SERVER_PATH` | `dist/mcp-server.js` | Custom MCP server executable |

### Deprecated

| Variable | Status |
|----------|--------|
| `SESSIONS_DIR` | Ignored with warning. Use `$MEMORY_DIR/.claude/` instead. |

### Docker Build Args

| Build Arg | Maps To | Default | Purpose |
|-----------|---------|---------|---------|
| `BUILD_VERSION` | `APP_VERSION` | `unknown` | Semantic version → health response + `X-Build-Version` header |
| `BUILD_COMMIT` | `BUILD_COMMIT` | `unknown` | Git hash → health response + `X-Build-Commit` header |
| `BUILD_TIME` | `BUILD_TIME` | `unknown` | ISO 8601 timestamp → health response |
| `ENABLE_LAMBDA_ADAPTER` | _(build only)_ | `false` | Install AWS Lambda Web Adapter |

---

## 2. Volumes

### Persistent (mount to durable storage)

| Mount Point | Env Var | R/W | Purpose |
|-------------|---------|-----|---------|
| `/data/memory` | `MEMORY_DIR` | RW | Agent workspace, persona, `.claude/` SDK state, user skills |
| `/data/store` | `STORE_DIR` | RW | SQLite database (synced after each request) |
| `/data/org` | `ORG_DIR` | RO | Org persona, skills, managed-mcp.json (optional) |

### Auto-created inside MEMORY_DIR

| Path | Created By | Purpose |
|------|------------|---------|
| `.claude/` | entrypoint.sh | SDK session state, symlinked to `~/.claude` |
| `.claude/settings.json` | entrypoint.sh | SDK config (agent teams, CLAUDE.md discovery) |
| `.claude/skills/` | entrypoint.sh | Effective skill set (three-tier sync destination) |
| `skills/` | entrypoint.sh | User skills (persistent source, hot-reloadable) |
| `conversations/` | agent-engine.ts | Archived transcripts (on-demand, rare) |

### Ephemeral

| Path | Env Var | Purpose |
|------|---------|---------|
| `/tmp/messages.db` | `LOCAL_DB_PATH` | Runtime SQLite (fast local I/O) |

---

## 3. API Endpoints

All except `/health` require `Authorization: Bearer <API_TOKEN>`.

### System

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (no auth) — status, version, database, volumes |
| POST | `/control/stop` | Graceful shutdown — sync DB, exit |

### Conversations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/chat` | Send message (create or resume conversation) |
| GET | `/chat` | List all conversations |
| GET | `/chat/:conversation_id` | Get conversation metadata |
| GET | `/chat/:conversation_id/messages` | Get message history |
| DELETE | `/chat/:conversation_id` | Delete conversation + related data |

### Tasks

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/task` | Create scheduled task |
| GET | `/tasks` | List all tasks |
| PUT | `/task/:task_id` | Update task |
| DELETE | `/task/:task_id` | Delete task |
| POST | `/task/trigger` | Execute specific task immediately |
| POST | `/task/check` | Execute next due task (for external cron) |

### Admin

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/reload-skills` | Re-sync skills from all tiers |
| GET | `/admin/skills` | Get skills summary |

---

## 4. POST /chat Options

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `message` | string | _(required)_ | User message text |
| `conversation_id` | string | _(auto-create)_ | Resume existing conversation |
| `sender` | string | `user` | Sender identifier |
| `sender_name` | string | = sender | Display name |
| `stream` | boolean | `false` | Enable SSE streaming |
| `max_execution_ms` | number | server max | Per-request timeout (capped at `MAX_EXECUTION_MS`) |
| `thinking` | boolean | `false` | Enable extended thinking |
| `max_thinking_tokens` | number | `10000` | Max thinking tokens |
| `show_tool_use` | boolean | `false` | Stream tool invocation events |
| `mcp_servers` | object | — | Per-request MCP servers (see §7) |

### SSE Events (when `stream: true`)

| Event | Payload | Condition |
|-------|---------|-----------|
| `start` | `{conversation_id, message_id}` | Always |
| `thinking` | `{text}` | `thinking: true` |
| `tool_use` | `{tool, input}` | `show_tool_use: true` |
| `chunk` | `{text}` | Always (per-token) |
| `done` | Full response | Always |
| `error` | `{error}` | On failure |

---

## 5. Persona & System Prompt

Assembly order (top = base, bottom = highest priority):

```
┌─────────────────────────────────────┐
│ Claude Code preset (built-in)       │  Always present
├─────────────────────────────────────┤
│ Org CLAUDE.md                       │  $ORG_DIR/CLAUDE.md (appended, optional)
├─────────────────────────────────────┤
│ User CLAUDE.md                      │  $MEMORY_DIR/CLAUDE.md (SDK auto-discovery)
└─────────────────────────────────────┘
```

- `SYSTEM_PROMPT_OVERRIDE` replaces the first two layers; user CLAUDE.md still loads on top.
- Both files are optional. Empty `/data/*` volumes work — agent runs with default prompt.

---

## 6. Skills

### Three-Tier Merge (load order)

| Tier | Source | Override Behavior | Reload |
|------|--------|-------------------|--------|
| Built-in | `$BUILT_IN_SKILLS_DIR` | Base layer | Container restart |
| Org | `$SKILLS_DIR` | Overrides built-in of same name | `POST /admin/reload-skills` |
| User | `$MEMORY_DIR/skills/` | Additive only (cannot override org/built-in) | `POST /admin/reload-skills` |

### Effective destination

`$MEMORY_DIR/.claude/skills/` — cleared and rebuilt on each sync.

### Runtime-created skills

Skills created by the agent during chat (written to `.claude/skills/`) are automatically persisted to `$MEMORY_DIR/skills/` before the next sync, so they survive container restarts.

---

## 7. MCP Servers

### Sources (3 layers)

| Source | Scope | Config Location | Availability |
|--------|-------|-----------------|--------------|
| Built-in `picoclaw` | Always | Hardcoded in `agent-engine.ts` | Every request |
| Org managed | Always (if configured) | `$ORG_DIR/managed-mcp.json` → `/etc/claude-code/` | Every request |
| Per-request | Single request | `mcp_servers` field in `POST /chat` | That request only |

### Per-request transport types

| Type | Required | Optional |
|------|----------|----------|
| `http` (default) | `url` | `headers` |
| `sse` | `url` | `headers` |
| `stdio` | `command` | `args`, `env` |

### Built-in MCP tools

| Tool | Purpose |
|------|---------|
| `mcp__picoclaw__send_message` | Queue message for HTTP caller |
| `mcp__picoclaw__schedule_task` | Create cron/interval/once task |
| `mcp__picoclaw__list_tasks` | List tasks (main: all; non-main: own only) |
| `mcp__picoclaw__pause_task` | Pause task |
| `mcp__picoclaw__resume_task` | Resume task |
| `mcp__picoclaw__cancel_task` | Delete task |
| `mcp__picoclaw__update_task` | Modify task fields |

---

## 8. Runtime Controls

### Shutdown

| Method | Trigger | Effect |
|--------|---------|--------|
| `POST /control/stop` | API call | sync DB → close → exit |
| `SIGTERM` | Platform signal | sync DB → close → exit |
| `SIGINT` | Ctrl+C | sync DB → close → exit |

### Database Sync

Runs automatically after every HTTP response and on shutdown: `wal_checkpoint(TRUNCATE)` → file copy to `STORE_DIR`.

### Config Reload Timing

| What | How to Reload |
|------|---------------|
| CLAUDE.md (user/org) | Automatic per-request (SDK re-reads on each `query()`) |
| `.claude/settings.json` | Automatic per-request |
| Skills (source dirs) | `POST /admin/reload-skills` |
| `managed-mcp.json` | Container restart |
| Environment variables | Container restart |

---

## 9. Response Headers

Every HTTP response includes:

| Header | Value |
|--------|-------|
| `X-Request-ID` | Echoes caller header or generates `req-<UUID>` |
| `X-Build-Version` | `APP_VERSION` |
| `X-Build-Commit` | `BUILD_COMMIT` |
