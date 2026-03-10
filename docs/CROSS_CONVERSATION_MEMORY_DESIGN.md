# PicoClaw Feature Gap Analysis & Implementation Plan

> Status: **Proposal** | Author: Claude Code | Date: 2026-03-10
>
> Target audience: PicoClaw contributors

## 1. Target Deployment Model

### 1.1 Scenario Description

```
User requests conversation
  ↓
Platform starts a container for this user
  ↓
Mount volumes:
  /data/skills-global  ← shared OSS (read-only, all users share)
  /data/skills         ← user OSS  (read-write, user-created skills)
  /data/memory         ← user OSS  (read-write, persona + notes + archives)
  /data/store          ← user OSS  (read-write, SQLite database)
  /data/sessions       ← user OSS  (read-write, SDK session state)
  ↓
Container runs: conversations, agents, tasks — all for ONE user
  ↓
User creates skills, builds memory, runs multi-agent workflows
  ↓
Agent signals completion: session_end_marker_detected = true
  ↓
Container shuts down → data synced to user's OSS directory
  ↓
Next session: new container, same OSS mount → resume conversations, inherit memory + skills
```

### 1.2 Key Invariants

- **One container = one user.** No multi-tenant concerns. SQLite single-writer is sufficient.
- **All data belongs to the user.** The user's OSS directory is the complete state: conversations, memory, skills, sessions. Back it up and the user's entire agent state is preserved.
- **Global skills are shared read-only.** Platform-provided skills (math, code review, etc.) come from a separate mount point that all users share. Users cannot modify them.
- **User skills are read-write.** The user (via the agent) can create new skills at runtime. These persist in the user's OSS directory and survive container restarts.

## 2. Gap Analysis

### 2.1 Current State vs Requirements

| Requirement | Current Status | Gap? |
|-------------|---------------|------|
| Per-user container with OSS volumes | `MEMORY_DIR` + `STORE_DIR` + `SESSIONS_DIR` mountable | No |
| Global shared skills (read-only) | Only **one** `SKILLS_DIR` — no dual-source merge | **Gap 1** |
| User-created skills at runtime | Skills discovered once at startup; no runtime refresh | **Gap 2** |
| Long-term memory across conversations | No `memory` table; no auto-injection | **Gap 3** |
| Multi-agent parallel execution | SDK subagents work; HTTP-level concurrency untested | **Gap 4** |
| Session end marker | `session_end_marker_detected` in response | No |
| Conversation resume after restart | `session_id` + `last_assistant_uuid` + dual-DB sync | No |
| MCP tool support | 7 built-in tools, extensible via `mcpServers` config | No |
| Data persistence to OSS | `syncDatabaseToVolume()` on every response + shutdown | No |

### 2.2 What Already Works

These capabilities are fully implemented and tested (26 e2e tests pass):

- **Conversation lifecycle:** Create, resume, multi-turn context retention
- **Session resume across restarts:** SQLite + SDK session files on persistent volume
- **Dual-DB sync:** `/tmp/messages.db` → `/data/store/messages.db` after every response
- **Graceful shutdown:** `SIGTERM`, `SIGINT`, `POST /control/stop` all sync before exit
- **Task scheduling:** CRUD + external cron trigger via `POST /task/check`
- **Skills sync at startup:** Copy from `SKILLS_DIR` to `.claude/skills/`
- **Persona via CLAUDE.md:** Loaded into system prompt for every conversation
- **Session end marker:** `[[PICOCLAW_SESSION_END]]` detected and flagged in response
- **Auth:** Bearer token on all endpoints except `/health`

## 3. Gap 1: Dual-Source Skills (Global + User)

### 3.1 Problem

Current `syncSkills()` reads from a single `SKILLS_DIR` and **clears** the destination before copying. If we mount global skills and user skills to the same path, one overwrites the other.

### 3.2 Solution

Add `SKILLS_GLOBAL_DIR` config. At startup, merge both sources into `.claude/skills/`:

```
Merge order (user wins on conflict):
  1. Copy all from /data/skills-global/*  →  .claude/skills/
  2. Copy all from /data/skills/*         →  .claude/skills/  (overwrites on conflict)
```

### 3.3 Changes

| File | Change |
|------|--------|
| `src/config.ts` | Add `SKILLS_GLOBAL_DIR` (default: `/data/skills-global`) |
| `src/skills.ts` | `syncSkills()`: copy global first, then user skills (user overrides global) |
| `entrypoint.sh` | Same merge logic in shell: global first, then user |
| `src/agent-engine.ts` | `discoverAdditionalDirectories()`: scan both directories |
| `src/index.ts` | `ensureDataDirectories()`: create `SKILLS_GLOBAL_DIR` |

### 3.4 Volume Mount Example

```bash
docker run \
  -v /oss/shared/skills:/data/skills-global:ro \  # global, read-only
  -v /oss/user-123/skills:/data/skills \           # user, read-write
  -v /oss/user-123/memory:/data/memory \
  -v /oss/user-123/store:/data/store \
  -v /oss/user-123/sessions:/data/sessions \
  picoclaw:latest
```

## 4. Gap 2: Runtime Skill Creation

### 4.1 Problem

Skills are discovered once at startup via `discoverAdditionalDirectories()`. If the agent creates a new skill during conversation A (`Write /data/skills/my-skill/SKILL.md`), conversation B won't see it until the container restarts.

### 4.2 Solution

Move `discoverAdditionalDirectories()` call from static initialization to per-request execution. Since each HTTP request creates a new `query()` call, re-scanning at that point picks up any new skills.

### 4.3 Changes

| File | Change |
|------|--------|
| `src/agent-engine.ts` | Call `discoverAdditionalDirectories()` inside `run()` instead of at module level. Also re-run `syncSkills()` to copy new skill dirs to `.claude/skills/`. |
| `docs/SKILLS_AND_PERSONA_GUIDE.md` | Document that agents can create skills by writing `SKILL.md` files to `/data/skills/<name>/` |

### 4.4 Persona Instruction

Add to CLAUDE.md template:

```markdown
## Creating Skills

You can create reusable skills by writing SKILL.md files:

1. Create directory: `/data/skills/<skill-name>/`
2. Write `SKILL.md` with YAML frontmatter (name, description) and instructions
3. The skill will be available in the next conversation turn

Skills you create persist across conversations and container restarts.
```

## 5. Gap 3: Cross-Conversation Long-Term Memory

### 5.1 Problem

All conversational state is isolated by `conversation_id`. Knowledge from conversation A is invisible to conversation B.

### 5.2 Design Principles

1. **Single-user, no concurrency concern.** One container = one user = one SQLite process. No multi-writer issues.
2. **System-level injection.** Memory is automatically loaded into every conversation's system prompt. Not dependent on agent behavior.
3. **Agent-driven storage.** The agent decides what to store via MCP tools. Optionally enhanced with automatic extraction later.
4. **Bounded injection.** `MAX_MEMORY_ENTRIES` config caps the token cost of memory context.

### 5.3 New SQLite Table: `memory`

```sql
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  source_conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory(tags);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated_at DESC);
```

Design decisions:

- `UNIQUE(key)` with upsert — "my name is Kevin" said twice updates, doesn't duplicate.
- No `FOREIGN KEY` on `source_conversation_id` — memory outlives its source conversation.
- Same SQLite database (`messages.db`) — automatically covered by existing dual-DB sync. No extra persistence logic.

### 5.4 New MCP Tools

| Tool | Parameters | Behavior |
|------|-----------|---------|
| `store_memory` | `key`, `value`, `tags?` | Upsert into `memory` table. Key exists → update value. |
| `recall_memory` | `query` | Substring search across key, value, tags. Returns top 20 matches. |
| `list_memory` | `tag?` | List all entries, optionally filtered by tag. |
| `delete_memory` | `key` | Delete entry by key. |

All tools are **unscoped** — they operate on the container's global memory, not per-conversation. This is correct because one container = one user.

### 5.5 Memory Injection

In `AgentEngine.run()`, before calling `query()`:

```typescript
function buildMemoryContext(limit: number): string {
  const entries = getRecentMemory(limit);
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.key}: ${e.value}`);
  return [
    '',
    '## Long-Term Memory',
    '',
    'The following facts are known from previous interactions:',
    '',
    ...lines,
    '',
  ].join('\n');
}

// Append to system prompt alongside globalClaudeMd
const memoryContext = buildMemoryContext(MAX_MEMORY_ENTRIES);
const fullAppend = [globalClaudeMd, memoryContext].filter(Boolean).join('\n');
```

### 5.6 Data Lifecycle

```
Container start
  ↓
  initDatabase() → memory table restored from /data/store/messages.db
  ↓
Conversation A:
  System prompt includes: (empty memory)
  User: "I'm Kevin, I code in Rust, my dog is Mochi"
  Agent: calls store_memory("user_name", "Kevin")
         calls store_memory("user_language", "Rust")
         calls store_memory("user_pet_name", "Mochi")
  ↓
  syncDatabaseToVolume() → memory persisted
  ↓
Conversation B:
  System prompt includes:
    ## Long-Term Memory
    - user_name: Kevin
    - user_language: Rust
    - user_pet_name: Mochi
  User: "What do you know about me?"
  Agent: "Your name is Kevin, you code in Rust, and your dog is Mochi."
  ↓
Container shutdown → syncDatabaseToVolume() → OSS archive
  ↓
Next container start → initDatabase() → memory table restored → all entries available
```

### 5.7 Persona Template for Memory

```markdown
## Memory Management

You have long-term memory tools that persist across conversations:

- `mcp__picoclaw__store_memory` — Save facts (use semantic keys like "user_name")
- `mcp__picoclaw__recall_memory` — Search stored facts
- `mcp__picoclaw__list_memory` — List all facts (optional tag filter)
- `mcp__picoclaw__delete_memory` — Remove outdated facts

Rules:
1. When you learn something important about the user, store it immediately.
2. When facts change, update by storing with the same key (upsert).
3. Delete facts that are no longer true.
```

## 6. Gap 4: HTTP-Level Concurrent Conversations

### 6.1 Current State

- Express handles multiple requests concurrently (Node.js event loop).
- Each conversation has a `status: 'running'` lock — same conversation_id gets `409 Conflict`.
- **Different** conversation_ids can technically run in parallel on the same Express instance.
- SQLite WAL mode allows concurrent reads + serial writes — safe for single-process.

### 6.2 Assessment

For the target scenario (one user, one container), parallel conversations are low-priority. The typical flow is sequential: user sends message → waits for response → sends next. Background agents (via SDK `Task` tool within a conversation) already support parallelism.

### 6.3 Recommended Action

- Document that different `conversation_id` requests can run concurrently.
- Add a `MAX_CONCURRENT_QUERIES` config (default: 1) for future resource control.
- No code change needed for v1 — SQLite WAL + single-process is safe.

## 7. Implementation Plan

### Phase 1: Dual-Source Skills (Gap 1 + Gap 2)

| Step | File | Change |
|------|------|--------|
| 1 | `src/config.ts` | Add `SKILLS_GLOBAL_DIR` env var |
| 2 | `src/skills.ts` | Merge global + user skills in `syncSkills()` |
| 3 | `entrypoint.sh` | Same merge logic in shell |
| 4 | `src/agent-engine.ts` | Re-scan skills per request in `run()` |
| 5 | `src/index.ts` | Create `SKILLS_GLOBAL_DIR` in `ensureDataDirectories()` |

Estimated effort: **1.5 hours**

### Phase 2: Memory System (Gap 3)

| Step | File | Change |
|------|------|--------|
| 6 | `src/types.ts` | Add `MemoryEntry` interface |
| 7 | `src/db.ts` | Add `memory` table schema + CRUD functions |
| 8 | `src/mcp-server.ts` | Add 4 MCP tools |
| 9 | `src/agent-engine.ts` | Add `buildMemoryContext()`, inject into system prompt |
| 10 | `src/config.ts` | Add `MAX_MEMORY_ENTRIES` (default: 50) |
| 11 | `src/db.test.ts` | Unit tests for memory CRUD |

Estimated effort: **2-3 hours**

### Phase 3: Documentation & Persona

| Step | File | Change |
|------|------|--------|
| 12 | `CLAUDE.md` | Add memory table to schema, new MCP tools, skills dual-source |
| 13 | `docs/SKILLS_AND_PERSONA_GUIDE.md` | Memory tools + runtime skill creation guide |
| 14 | `docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md` | Volume mount examples with dual skills |
| 15 | `CHANGELOG.md` | New features documented |

Estimated effort: **30 minutes**

### Phase 4: E2E Tests

| Step | File | Change |
|------|------|--------|
| 16 | `scripts/e2e-test.sh` | New sections: cross-conv memory, skill creation, dual-source skills |

New test cases:

- **Memory:** Store fact in conv A → conv B recalls without being told → delete → conv C doesn't know
- **Skills:** Agent creates skill in conv A → conv B sees it in next request
- **Dual-source:** Global skill present → user skill overrides it → both discoverable

Estimated effort: **1 hour**

### Phase 5: Future Enhancements

| Enhancement | Effort | Priority |
|-------------|--------|----------|
| Automatic fact extraction (post-response hook) | 2-3h | P1 |
| `GET /memory` admin API | 1h | P2 |
| `POST /skills` API for external skill injection | 1h | P2 |
| Memory TTL/expiry | 1h | P3 |
| Vector similarity search (sqlite-vss) | 4-6h | P3 |

## 8. Volume Mount Reference

### 8.1 Full Deployment

```bash
docker run \
  -e API_TOKEN=<token> \
  -e ANTHROPIC_BASE_URL=<url> \
  -e ANTHROPIC_API_KEY=<key> \
  -v /oss/shared/skills:/data/skills-global:ro \
  -v /oss/user-123/skills:/data/skills \
  -v /oss/user-123/memory:/data/memory \
  -v /oss/user-123/store:/data/store \
  -v /oss/user-123/sessions:/data/sessions \
  picoclaw:latest
```

### 8.2 Volume Ownership

| Volume | Source | Mode | Content |
|--------|--------|------|---------|
| `/data/skills-global` | Shared OSS | `ro` | Platform-provided skills |
| `/data/skills` | User OSS | `rw` | User-created skills |
| `/data/memory` | User OSS | `rw` | CLAUDE.md persona, notes, archives |
| `/data/store` | User OSS | `rw` | SQLite DB (conversations, messages, memory, tasks) |
| `/data/sessions` | User OSS | `rw` | SDK session state (`.claude/`) |

### 8.3 OSS Archive Strategy

On container shutdown, the user's OSS directory contains:

```
/oss/user-123/
  skills/              → User-created skills (persist across sessions)
  memory/
    CLAUDE.md          → Persona (may be updated by agent)
    global/CLAUDE.md   → Global context
    conversations/     → Archived transcripts
    notes/             → Agent-written notes
  store/
    messages.db        → All conversations, messages, memory entries, tasks
  sessions/
    .claude/           → SDK session state for resume
```

Back up this directory = back up the user's entire agent state. Restore it to a new container = full continuity.

## 9. Migration & Compatibility

### 9.1 Schema Migration

All new tables use `CREATE TABLE IF NOT EXISTS`. Existing databases are upgraded automatically on `initDatabase()`. No migration scripts needed.

### 9.2 Backward Compatibility

- Containers without memory entries behave identically to today.
- Containers without `SKILLS_GLOBAL_DIR` mount skip global skills (empty directory fallback).
- New MCP tools are auto-discovered by the agent — no config change required.
- No changes to HTTP API contract.

### 9.3 Rollback

- **Memory:** Drop the `memory` table, remove MCP tools and injection code.
- **Dual-source skills:** Remove `SKILLS_GLOBAL_DIR` config, revert to single-source.
- Both changes are additive and independently reversible.

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Agent doesn't consistently call `store_memory` | Phase 5: automatic extraction hook as system-level backup |
| Memory injection uses too many tokens | `MAX_MEMORY_ENTRIES` config with conservative default (50) |
| Stale facts persist across sessions | `delete_memory` tool + persona instructions to correct outdated info |
| User-created skills have invalid SKILL.md format | Agent follows template in persona; invalid skills are silently ignored by SDK |
| `SKILLS_GLOBAL_DIR` not mounted | Fallback: empty directory, no global skills — same as today |

## 11. Open Questions

1. **Memory in isolated tasks.** Should `context_mode: isolated` tasks receive memory injection? Recommendation: yes — the user's facts are relevant regardless of task type.

2. **Skill namespacing.** If global and user skills share a name, user wins. Should this be logged/warned? Recommendation: log at `info` level during skill merge.

3. **Memory export format.** For OSS archival, is SQLite sufficient or should we also export `memory` as JSON? Recommendation: SQLite is sufficient for v1; add JSON export in Phase 5 if needed.
