# PicoClaw Design Rationale

Architectural decisions and first-principles reasoning behind PicoClaw's design. This document captures the "why" behind key choices for developers and architects evaluating or extending the system.

## Origin: NanoClaw to PicoClaw

PicoClaw is a serverless adaptation of [NanoClaw](https://github.com/qwibitai/nanoclaw), an always-on multi-channel Claude Agent orchestrator. NanoClaw uses a host process that manages Docker child containers — one per agent session — with channel adapters (WhatsApp, Telegram, etc.) feeding messages through a router.

This architecture works well for persistent, multi-channel deployments but creates friction in serverless environments:

| Concern | NanoClaw (Docker child containers) | PicoClaw (single container) |
|---------|------------------------------------|-----------------------------|
| Cold start | Host + child container spin-up | Single process boot |
| Resource model | N containers × memory | Single process |
| Scheduling | Internal cron loop | External cron triggers |
| Channel routing | Multi-adapter router | HTTP API only |
| Filesystem | Source tree + container volumes | Mounted volumes at `/data/*` |
| State isolation | Per-container filesystem | Per-conversation SQLite rows |

The core insight: in a serverless (Lambda/FC) context, the platform already provides the execution container. Adding Docker-in-Docker adds latency, complexity, and resource overhead with no isolation benefit — the cloud platform's sandbox is the security boundary.

## Why Single-Container, Same-Process Agent

NanoClaw's Docker child container model spawns a separate container per agent session. The host sends messages via IPC files, and the child runs Claude Code with full filesystem isolation.

PicoClaw eliminates this layer:

1. **The Claude Agent SDK runs in-process.** `query()` spawns a CLI subprocess internally — that's the SDK's own execution model, not something we add. Wrapping it in another Docker container adds a third process layer with no functional benefit.

2. **Filesystem isolation is replaced by volume semantics.** Instead of each container having its own filesystem, PicoClaw mounts four well-defined volumes. The agent's `cwd` is set to `MEMORY_DIR`, and skills are synced to `.claude/skills/` at startup.

3. **Session state moves from container lifecycle to database rows.** NanoClaw ties a session to a container's lifetime. PicoClaw stores `session_id` and `last_assistant_uuid` in SQLite, enabling resume across separate HTTP requests.

## Why SQLite on /tmp (Dual-Database Sync)

### The Problem

Serverless platforms (Lambda, FC) typically provide:
- **Ephemeral local storage** (`/tmp`): fast, SSD-backed, but lost on container recycling.
- **Network-attached persistent storage** (EFS, NAS): durable but with higher latency and SQLite compatibility risks.

SQLite on NFS/EFS has known issues:
- File locking may not work correctly across NFS clients.
- WAL mode can corrupt if multiple processes access the same database file on network storage.
- Latency for frequent small writes (common in chat applications) degrades performance.

### The Solution

PicoClaw uses a **dual-path strategy**:

1. On startup, copy `/data/store/messages.db` → `/tmp/messages.db`.
2. All runtime reads/writes operate on `/tmp/messages.db` (fast local I/O).
3. After each HTTP response: `PRAGMA wal_checkpoint(TRUNCATE)` + file copy back to `/data/store/messages.db`.
4. On shutdown: final sync before process exit.

This gives SQLite its preferred environment (local filesystem with proper locking) while ensuring durability through explicit sync points. The worst-case data loss window is a single in-flight request if the container is forcefully killed.

### Why `wal_checkpoint(TRUNCATE)`

WAL (Write-Ahead Log) mode enables concurrent reads during writes. However, copying a database file while the WAL has uncommitted pages would produce an inconsistent copy. `TRUNCATE` mode checkpoints all WAL pages into the main database file and then truncates the WAL to zero length, ensuring the main `.db` file is self-contained and safe to copy.

## Why MCP Server is a Subprocess

The Claude Agent SDK requires MCP servers to be external processes communicating via stdio (or SSE/HTTP). This is not a design choice — it's a constraint of the SDK's architecture:

```
SDK (sdk.mjs) → spawns CLI (cli.js) → CLI spawns MCP servers (stdio)
```

The CLI process manages MCP server lifecycle. An in-process MCP server would require the SDK to support it natively (which it does via `type: 'sdk'`), but stdio transport is more reliable for PicoClaw because:

1. **The MCP server shares the same SQLite database.** It receives `NANOCLAW_DB_PATH` as an environment variable and opens its own connection. This works because both the main process and MCP subprocess run on the same machine, accessing the same `/tmp/messages.db` file.

2. **Process isolation prevents MCP crashes from taking down the HTTP server.** If an MCP tool handler throws, only the subprocess is affected.

3. **Subagent inheritance works naturally.** When the SDK spawns subagents (Task tool), those subagents can also access the MCP server because stdio transport is inherited through the process tree.

## Why MessageStream (AsyncIterable Prompt)

PicoClaw wraps the user's prompt in a `MessageStream` (async iterable) instead of passing it as a plain string to `query()`. This is a deliberate design choice driven by how the SDK handles agent lifecycle:

When `query()` receives a **string** prompt, it sets `isSingleUserTurn = true`. After the first `result` message, the SDK closes stdin to the CLI process. This triggers a shutdown cascade that kills any running subagents — even if they're mid-execution.

When `query()` receives an **AsyncIterable**, `isSingleUserTurn = false`. The SDK keeps stdin open, allowing:
- Background agents to complete their work.
- Agent Teams to coordinate through the full lifecycle.
- The caller to control when the session ends (by calling `end()` on the stream).

PicoClaw's `MessageStream` pushes one message and immediately calls `end()`, but the iterable type prevents premature stdin closure during agent execution.

## Why Four Separate Volumes

The four-volume model (`memory`, `skills`, `sessions`, `store`) separates concerns:

| Volume | Lifecycle | Write Pattern | Sharing |
|--------|-----------|---------------|---------|
| `memory` | Long-lived | Agent writes (persona, archives) | Shared across deploys |
| `skills` | Deploy-time | Human/CI writes skill definitions | Read-only at runtime |
| `sessions` | Per-instance | SDK writes `.claude/` state | Instance-specific |
| `store` | Long-lived | Sync from `/tmp` after each request | Shared across deploys |

This separation enables:
- **Skills as deployment artifacts**: update skills by mounting a new volume, no image rebuild.
- **Independent backup policies**: `store` (critical) vs `skills` (reproducible).
- **Session isolation**: each container instance can have its own `.claude/` state without conflicts.

## Why External Cron for Task Scheduling

NanoClaw runs an internal scheduling loop that checks for due tasks every N seconds. This requires a persistent process — incompatible with serverless.

PicoClaw's `POST /task/check` endpoint inverts the control:

1. External cron (EventBridge, FC timer trigger) calls `/task/check` every minute.
2. The endpoint queries `scheduled_tasks WHERE status = 'active' AND next_run <= NOW()`.
3. Executes at most one task, then returns.

**One task per call** is intentional:
- Prevents a single Lambda invocation from running indefinitely if many tasks are due.
- Allows the platform to manage concurrency and timeout per task execution.
- Backlogs are visible via the `remaining` field in the response.

## Timeout and Abort Design

The agent timeout uses `AbortController` — the standard JavaScript cancellation primitive:

```typescript
const abortController = new AbortController();
const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
```

This is passed directly to `query()`, which threads it through to the CLI subprocess. When aborted:
- The SDK terminates the CLI process.
- Any in-progress API call or tool execution is cancelled.
- PicoClaw catches the `AbortError` and returns `status: "timeout"` with any partial result.

The timeout has two levels:
- **Server-level**: `MAX_EXECUTION_MS` environment variable (default: 300s).
- **Per-request**: `max_execution_ms` in the chat request body, capped at the server-level maximum.

For Lambda deployments, set `MAX_EXECUTION_MS` at least 30 seconds below the Lambda timeout to ensure the sync-and-exit sequence completes.

## Session Resume Mechanics

Cross-request conversation continuity uses the SDK's built-in session resume:

1. First request: `query()` returns a `system/init` message with `session_id`, and `assistant` messages with `uuid` values.
2. PicoClaw stores `session_id` and the last `assistant.uuid` in the `conversations` table.
3. Next request: `query()` receives `resume: session_id` and `resumeSessionAt: last_assistant_uuid`.
4. The SDK locates the session file on disk (in `SESSIONS_DIR/.claude/`) and resumes from the specified message.

This is why `SESSIONS_DIR` must be persistent — the SDK's session files contain the full conversation state needed for resume.

## Security Model Changes

NanoClaw's security relies on Docker container isolation: each agent runs in a sandboxed container with controlled filesystem access. Credential injection uses a proxy that grants temporary tokens.

PicoClaw replaces this with:

1. **HTTP Bearer token authentication** as the primary boundary.
2. **Environment variable scrubbing** via `PreToolUse` hook: before any Bash command, `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are unset.
3. **API proxy support** via `ANTHROPIC_BASE_URL`: the SDK reads this from `process.env` to route API calls to a custom endpoint (e.g. third-party proxies, regional endpoints, or self-hosted gateways). Passed through the same `env` object as `ANTHROPIC_API_KEY`.
4. **Container boundary** as the blast radius limit — the agent has full Bash access within the container, but the container itself is the sandbox.
5. **MCP tool ownership**: non-main sessions can only manage tasks belonging to their conversation.

See `docs/SECURITY.md` for the complete trust model.
