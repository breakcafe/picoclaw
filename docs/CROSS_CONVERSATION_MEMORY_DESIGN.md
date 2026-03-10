# Cross-Conversation Memory System — Design & Implementation Plan

> Status: **Proposal** | Author: Claude Code | Date: 2026-03-10
>
> Target audience: PicoClaw contributors implementing long-term memory

## 1. Problem Statement

### 1.1 Current Behavior

PicoClaw isolates all conversational state by `conversation_id`:

- SQLite `messages` table has `FOREIGN KEY (conversation_id)` — no cross-conversation queries exist.
- MCP tools (`send_message`, `schedule_task`) are scoped to `NANOCLAW_CONVERSATION_ID`.
- SDK session resume (`resume` + `resumeSessionAt`) is per-conversation.

If a user tells conversation A "my name is Kevin", conversation B has **no automatic way** to know this.

### 1.2 Target Use Case

```
One container = one user
├── Conversation A (research task)     ──┐
├── Conversation B (coding task)         ├── All belong to the same user
├── Conversation C (scheduled report)  ──┘
└── Container lifecycle: start → work → archive to OSS → destroy
```

Within a container's lifetime, all conversations serve the same user. Knowledge learned in any conversation should be accessible to all others. After the container is destroyed, the archived data belongs entirely to that user.

### 1.3 What's Missing

| Capability | Current | Needed |
|-----------|---------|--------|
| Agent learns a fact in conv A | Stored in conv A's session only | Persisted globally |
| Conv B starts, needs user context | Starts blank (only CLAUDE.md persona) | Auto-injected with known facts |
| Agent writes a note for later | File write to `/data/memory/` (manual) | Structured, queryable storage |
| Search across all conversations | Not possible via MCP tools | MCP tool for cross-conv search |
| Container shutdown | DB + sessions archived | Memory index archived alongside |

## 2. Architecture Overview

### 2.1 Design Principles

1. **System-level, not agent-dependent.** Memory persistence must not rely on the agent choosing to write files. The system extracts and injects memory automatically.
2. **Additive, not invasive.** New table + new MCP tools + hook enhancement. No changes to existing conversation isolation or session resume logic.
3. **Bounded injection.** Memory injected into prompts must be token-bounded to avoid consuming the context window.
4. **Graceful degradation.** If memory is empty or unavailable, conversations work exactly as today.

### 2.2 Component Diagram

```
                    ┌──────────────────────────────────┐
                    │        /data/memory/              │
                    │  CLAUDE.md  global/  notes/       │
                    │  conversations/  (unchanged)      │
                    └──────────────────────────────────┘

┌─────────────┐     ┌──────────────────────────────────┐
│  POST /chat │────>│         Agent Engine              │
│  (new conv) │     │                                    │
└─────────────┘     │  1. Load memory entries            │
                    │     (getRecentMemory)              │
                    │  2. Inject into system prompt      │
                    │     (bounded by MAX_MEMORY_TOKENS) │
                    │  3. Run query()                    │
                    │  4. Post-response hook:            │
                    │     extract facts → store_memory   │
                    └──────────┬───────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │        SQLite (memory table)     │
              │                                  │
              │  id | key | value | source_conv  │
              │  -- | --- | ----- | ------------ │
              │  1  | user_name | Kevin | conv-A │
              │  2  | user_lang | Rust  | conv-A │
              │  3  | user_pet  | Mochi | conv-A │
              └──────────────────────────────────┘

              ┌──────────────────────────────────┐
              │        MCP Tools (new)           │
              │                                  │
              │  store_memory(key, value, tags)  │
              │  recall_memory(query)            │
              │  list_memory(tag?)               │
              │  delete_memory(key)              │
              └──────────────────────────────────┘
```

## 3. Detailed Design

### 3.1 New SQLite Table: `memory`

Add to `src/db.ts` schema:

```sql
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,           -- Semantic key: "user_name", "project_goal", etc.
  value TEXT NOT NULL,                -- Free-text value
  tags TEXT NOT NULL DEFAULT '',      -- Comma-separated tags for filtering
  source_conversation_id TEXT,        -- Which conversation created this entry
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory(tags);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated_at DESC);
```

**Design decisions:**

- `key` is `UNIQUE` — updating an existing key replaces the value (upsert semantics). This prevents unbounded growth from repeated "my name is X" statements.
- `tags` enables filtering: `"user_profile"`, `"project"`, `"preference"`, etc.
- `source_conversation_id` is nullable (for entries injected externally or at container setup).
- No `FOREIGN KEY` on `source_conversation_id` — memory entries outlive their source conversations.

### 3.2 New DB Functions

Add to `src/db.ts`:

```typescript
// ── Memory CRUD ─────────────────────────────────────────

export function storeMemory(input: {
  key: string;
  value: string;
  tags?: string;
  sourceConversationId?: string;
}): void {
  const now = getNowIso();
  getDbOrThrow()
    .prepare(
      `INSERT INTO memory (key, value, tags, source_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         tags = excluded.tags,
         source_conversation_id = excluded.source_conversation_id,
         updated_at = excluded.updated_at`,
    )
    .run(input.key, input.value, input.tags ?? '', input.sourceConversationId ?? null, now, now);
}

export function recallMemory(query: string): MemoryEntry[] {
  // Simple substring search across key, value, and tags
  const pattern = `%${query}%`;
  return getDbOrThrow()
    .prepare(
      `SELECT id, key, value, tags, source_conversation_id, created_at, updated_at
       FROM memory
       WHERE key LIKE ? OR value LIKE ? OR tags LIKE ?
       ORDER BY updated_at DESC
       LIMIT 20`,
    )
    .all(pattern, pattern, pattern) as MemoryEntry[];
}

export function listMemory(tag?: string): MemoryEntry[] {
  if (tag) {
    return getDbOrThrow()
      .prepare(
        `SELECT id, key, value, tags, source_conversation_id, created_at, updated_at
         FROM memory
         WHERE tags LIKE ?
         ORDER BY updated_at DESC`,
      )
      .all(`%${tag}%`) as MemoryEntry[];
  }
  return getDbOrThrow()
    .prepare(
      `SELECT id, key, value, tags, source_conversation_id, created_at, updated_at
       FROM memory
       ORDER BY updated_at DESC`,
    )
    .all() as MemoryEntry[];
}

export function deleteMemory(key: string): boolean {
  const result = getDbOrThrow()
    .prepare('DELETE FROM memory WHERE key = ?')
    .run(key);
  return result.changes > 0;
}

export function getRecentMemory(limit: number = 50): MemoryEntry[] {
  return getDbOrThrow()
    .prepare(
      `SELECT id, key, value, tags, source_conversation_id, created_at, updated_at
       FROM memory
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as MemoryEntry[];
}
```

### 3.3 New Interface: `MemoryEntry`

Add to `src/types.ts`:

```typescript
export interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  tags: string;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}
```

### 3.4 New MCP Tools

Add to `src/mcp-server.ts`:

```typescript
// ── Memory Tools ─────────────────────────────────────

server.tool(
  'store_memory',
  'Store a fact or note in long-term memory. Accessible across all conversations in this container. Use a semantic key (e.g. "user_name", "project_goal"). If the key already exists, its value is updated.',
  {
    key: z.string().describe('Semantic key, e.g. "user_name", "user_preference_language"'),
    value: z.string().describe('The information to store'),
    tags: z.string().optional().describe('Comma-separated tags for categorization, e.g. "user_profile,preference"'),
  },
  async (args) => {
    db.prepare(
      `INSERT INTO memory (key, value, tags, source_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         tags = excluded.tags,
         source_conversation_id = excluded.source_conversation_id,
         updated_at = excluded.updated_at`,
    ).run(
      args.key,
      args.value,
      args.tags || '',
      conversationId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    return { content: [{ type: 'text' as const, text: `Memory stored: ${args.key}` }] };
  },
);

server.tool(
  'recall_memory',
  'Search long-term memory for facts matching a query. Searches across keys, values, and tags.',
  {
    query: z.string().describe('Search term to find in memory'),
  },
  async (args) => {
    const rows = db
      .prepare(
        `SELECT key, value, tags, updated_at FROM memory
         WHERE key LIKE ? OR value LIKE ? OR tags LIKE ?
         ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(`%${args.query}%`, `%${args.query}%`, `%${args.query}%`) as Array<{
      key: string;
      value: string;
      tags: string;
      updated_at: string;
    }>;

    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
    }

    const text = rows
      .map((r) => `- **${r.key}**: ${r.value}${r.tags ? ` [${r.tags}]` : ''} (${r.updated_at})`)
      .join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'list_memory',
  'List all entries in long-term memory, optionally filtered by tag.',
  {
    tag: z.string().optional().describe('Filter by tag, e.g. "user_profile"'),
  },
  async (args) => {
    const rows = args.tag
      ? db
          .prepare(
            `SELECT key, value, tags, updated_at FROM memory
             WHERE tags LIKE ? ORDER BY updated_at DESC`,
          )
          .all(`%${args.tag}%`)
      : db.prepare('SELECT key, value, tags, updated_at FROM memory ORDER BY updated_at DESC').all();

    if ((rows as unknown[]).length === 0) {
      return { content: [{ type: 'text' as const, text: 'Memory is empty.' }] };
    }

    const text = (rows as Array<{ key: string; value: string; tags: string; updated_at: string }>)
      .map((r) => `- **${r.key}**: ${r.value}${r.tags ? ` [${r.tags}]` : ''}`)
      .join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'delete_memory',
  'Delete a specific memory entry by key.',
  {
    key: z.string().describe('The key to delete'),
  },
  async (args) => {
    const result = db.prepare('DELETE FROM memory WHERE key = ?').run(args.key);
    if (result.changes > 0) {
      return { content: [{ type: 'text' as const, text: `Memory deleted: ${args.key}` }] };
    }
    return { content: [{ type: 'text' as const, text: `Key not found: ${args.key}` }] };
  },
);
```

### 3.5 Memory Injection into Agent Prompts

Modify `src/agent-engine.ts` — in the `AgentEngine.run()` method, **before** constructing the SDK `query()` call:

```typescript
// ── Load cross-conversation memory ──────────────────
function buildMemoryContext(): string {
  try {
    const entries = getRecentMemory(50);
    if (entries.length === 0) return '';

    const lines = entries.map((e) => `- ${e.key}: ${e.value}`);
    return [
      '',
      '## Long-Term Memory',
      '',
      'The following facts are known from previous conversations in this session:',
      '',
      ...lines,
      '',
    ].join('\n');
  } catch {
    return ''; // Graceful degradation
  }
}
```

Then append to the system prompt:

```typescript
const memoryContext = buildMemoryContext();
const fullAppend = [globalClaudeMd, memoryContext].filter(Boolean).join('\n');

// In query() options:
systemPrompt: fullAppend
  ? {
      type: 'preset',
      preset: 'claude_code',
      append: fullAppend,
    }
  : undefined,
```

**Token budget control:** The `LIMIT 50` in `getRecentMemory()` bounds the injection. At ~20 tokens per entry average, this costs ~1000 tokens — well within budget. A future `MAX_MEMORY_TOKENS` config could add explicit truncation.

### 3.6 Automatic Memory Extraction (Optional Enhancement)

Add a **PostToolUse** hook or a post-response processing step that prompts the agent to extract key facts. This is the "system-level" guarantee that memory isn't solely agent-dependent.

**Option A: PostResponse extraction (recommended)**

After `query()` completes in `AgentEngine.run()`, invoke a lightweight extraction:

```typescript
// After capturing result from query()
if (result && result.length > 50) {
  // Fire-and-forget: extract facts from this turn's exchange
  extractMemoryFromTurn(input.prompt, result, input.conversationId);
}
```

Where `extractMemoryFromTurn` could:
- Use a simple heuristic (regex for "my name is X", "I like X", "remember that X")
- Or call a fast model (Haiku) with a structured extraction prompt
- Or defer to the agent itself via an MCP tool hint in CLAUDE.md

**Option B: CLAUDE.md instruction (simpler, current-compatible)**

Add to the persona template:

```markdown
## Memory Management

You have access to long-term memory tools that persist across conversations:

- `mcp__picoclaw__store_memory` — Save important facts (user preferences, project context, decisions)
- `mcp__picoclaw__recall_memory` — Search for previously stored facts
- `mcp__picoclaw__list_memory` — List all stored facts
- `mcp__picoclaw__delete_memory` — Remove outdated facts

**Rules:**
1. When you learn something important about the user (name, preferences, project details), store it immediately.
2. At the start of each conversation, check memory for relevant context.
3. Use semantic keys like "user_name", "project_language", "user_preference_timezone".
```

**Recommendation:** Start with Option B (simpler, no model cost), add Option A later if agents don't consistently store facts.

## 4. Data Lifecycle

### 4.1 Within Container Lifetime

```
Container start
  ↓
  initDatabase() — memory table created (empty or restored from volume)
  ↓
Conversation A:
  1. Agent engine loads getRecentMemory() → empty → no injection
  2. User says "I'm Kevin, I code in Rust"
  3. Agent calls store_memory("user_name", "Kevin", "user_profile")
  4. Agent calls store_memory("user_language", "Rust", "user_profile")
  ↓
Conversation B:
  1. Agent engine loads getRecentMemory() → 2 entries
  2. System prompt includes:
     "## Long-Term Memory
      - user_name: Kevin
      - user_language: Rust"
  3. User asks "what do you know about me?"
  4. Agent answers "Your name is Kevin and you code in Rust" — WITHOUT user repeating it
  ↓
Container shutdown
  ↓
  syncDatabaseToVolume() — memory table persisted to /data/store/messages.db
```

### 4.2 Cross-Container (Archive & Restore)

The `memory` table lives in the same SQLite database (`messages.db`) that already gets synced to `/data/store/`. When the container is destroyed and data is archived to OSS:

1. `/data/store/messages.db` contains the full `memory` table
2. Next container for the same user restores this database
3. `initDatabase()` copies it to `/tmp/messages.db`
4. All memory entries are immediately available

No special migration or export step is needed — it's part of the existing dual-DB sync.

### 4.3 Memory Cleanup

Over time, memory entries may become stale. Strategies:

- **TTL-based:** Add `expires_at` column, `DELETE WHERE expires_at < NOW()` on startup.
- **LRU-based:** Track `last_accessed_at`, prune entries not accessed in N days.
- **Agent-driven:** The agent can call `delete_memory` to remove outdated facts.
- **Manual:** Operator clears via direct DB access or a future admin API.

**Recommendation for v1:** Agent-driven deletion + `LIMIT 50` on injection is sufficient. Add TTL in v2 if growth becomes an issue.

## 5. Implementation Plan

### Phase 1: Schema + MCP Tools (1-2 hours)

| Step | File | Change |
|------|------|--------|
| 1 | `src/types.ts` | Add `MemoryEntry` interface |
| 2 | `src/db.ts` | Add `memory` table to schema, add CRUD functions |
| 3 | `src/mcp-server.ts` | Add 4 MCP tools: `store_memory`, `recall_memory`, `list_memory`, `delete_memory` |
| 4 | `src/db.test.ts` | Add unit tests for memory CRUD |

**Verification:** `npm run build && npm test`

### Phase 2: Memory Injection (30 min)

| Step | File | Change |
|------|------|--------|
| 5 | `src/agent-engine.ts` | Add `buildMemoryContext()`, append to `systemPrompt` |
| 6 | `src/config.ts` | Add `MAX_MEMORY_ENTRIES` config (default: 50) |

**Verification:** Start container, store memory in conv A, verify it appears in conv B's system prompt.

### Phase 3: Persona Template Update (15 min)

| Step | File | Change |
|------|------|--------|
| 7 | `dev-data/memory/CLAUDE.md` | Add memory management instructions |
| 8 | `docs/SKILLS_AND_PERSONA_GUIDE.md` | Document memory tools in persona authoring guide |

### Phase 4: E2E Test (30 min)

| Step | File | Change |
|------|------|--------|
| 9 | `scripts/e2e-test.sh` | Add Section 10: "Cross-Conversation Memory" tests |

New test cases:
- Store fact in conversation A via `POST /chat`
- Start conversation B, verify fact is recalled without being told
- `recall_memory` finds stored fact
- `delete_memory` removes it
- New conversation C no longer sees deleted fact

### Phase 5: Documentation (15 min)

| Step | File | Change |
|------|------|--------|
| 10 | `CLAUDE.md` | Add `memory` table to schema section, document MCP tools |
| 11 | `CHANGELOG.md` | Add entry for cross-conversation memory |
| 12 | `docs/api/openapi.yaml` | No API change needed (memory is internal to agent) |

### Phase 6: Optional Enhancements (Future)

| Enhancement | Effort | Value |
|-------------|--------|-------|
| Automatic fact extraction (PostResponse hook + Haiku) | 2-3h | High — removes agent dependency |
| `GET /memory` admin API for external inspection | 1h | Medium — debugging/monitoring |
| TTL-based expiry (`expires_at` column) | 1h | Low — premature for v1 |
| Vector similarity search (sqlite-vss) | 4-6h | High — semantic recall instead of substring |
| Memory import/export API for container migration | 2h | Medium — OSS archive integration |

## 6. Migration & Compatibility

### 6.1 Schema Migration

The `memory` table is **additive** — existing databases without it will have the table created on next `initDatabase()` call. The `CREATE TABLE IF NOT EXISTS` guard ensures no conflict with existing data.

### 6.2 Backward Compatibility

- Containers without memory entries work identically to today (empty `getRecentMemory()` → no injection).
- The MCP tools are new additions — existing agent sessions discover them automatically.
- No changes to existing API contract (`POST /chat`, `POST /task`, etc.).
- No changes to existing conversation isolation or session resume.

### 6.3 Rollback

Drop the `memory` table and remove the MCP tools. No other components depend on them.

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Agent doesn't call `store_memory` | Memory stays empty | Phase 6: automatic extraction hook |
| Memory injection bloats system prompt | Reduced context for conversation | `MAX_MEMORY_ENTRIES` config, token counting |
| Stale/wrong facts persist | Agent gives incorrect answers | `delete_memory` tool + persona instructions to correct outdated info |
| Concurrent writes from parallel agents | SQLite write contention | SQLite WAL mode handles this; single-writer per process already enforced |
| Memory grows unbounded | DB size, injection cost | `LIMIT` on queries, future TTL/LRU pruning |

## 8. Open Questions

1. **Should memory injection be opt-in per conversation?** Some task-type conversations (e.g., `context_mode: isolated`) might not benefit from memory injection. Consider a `skip_memory` flag on `POST /chat`.

2. **Should the agent auto-recall at conversation start?** Current design injects memory into the system prompt. An alternative is to NOT inject but instruct the agent to call `recall_memory` proactively. Trade-off: injection is guaranteed but costs tokens; explicit recall is cheaper but agent-dependent.

3. **Key namespace conventions.** Should keys follow a convention like `user.name`, `project.language`, `preference.timezone`? Or free-form? Recommendation: document conventions in persona guide, don't enforce in code.

4. **Memory visibility in HTTP responses.** Should `POST /chat` responses include a `memory_entries_injected` count for observability? Useful for debugging but adds to response payload.

## 9. Appendix: Current Memory Mechanisms (Reference)

For completeness, here's what exists today and how it relates to the proposed system:

| Mechanism | Scope | Automatic? | Proposed Change |
|-----------|-------|-----------|----------------|
| `/data/memory/CLAUDE.md` | All convs (system prompt) | Yes | Unchanged — persona definition |
| `/data/memory/global/CLAUDE.md` | All convs (system prompt append) | Yes | Unchanged — global context |
| SDK auto-memory (`MEMORY.md`) | Per-project (cwd) | Yes (SDK-managed) | Unchanged — complementary |
| Agent file writes (`/data/memory/notes/`) | All convs (shared cwd) | No (agent-driven) | Unchanged — filesystem-based alternative |
| Conversation archives (`/data/memory/conversations/`) | Read-only reference | Yes (PreCompact hook) | Unchanged — archival |
| **`memory` table (NEW)** | **All convs (system prompt inject)** | **Yes (inject) + Agent (write)** | **Core addition** |
