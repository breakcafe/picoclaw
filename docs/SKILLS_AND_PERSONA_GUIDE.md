# Skills and Persona Authoring Guide

How to customize PicoClaw's behavior by writing skills and defining agent personas.

## Persona Configuration

The agent persona is defined by `CLAUDE.md` files. PicoClaw supports a **two-tier persona** model where an organization-level (org) persona and a user-level persona are stacked together.

### How persona loading works

The Claude Agent SDK discovers and loads CLAUDE.md files through two complementary mechanisms:

1. **User persona** (`/data/memory/CLAUDE.md`): The agent engine sets `cwd: MEMORY_DIR` and `settingSources: ['project', 'user']`. The Claude Code CLI automatically discovers `CLAUDE.md` in its working directory — this is standard Claude Code behavior. This file defines the agent's identity, capabilities, and behavioral rules for the specific user.

2. **Org persona** (`$ORG_DIR/CLAUDE.md`): When the `ORG_DIR` environment variable is set and the file exists, PicoClaw loads it via `loadOrgClaudeMd()` and passes it as `systemPrompt: { type: 'preset', preset: 'claude_code', append: orgClaudeMd }`. This appends organization-wide instructions to the Claude Code system prompt. Useful for shared policies, compliance rules, or default behavior across all users.

The effective system prompt is assembled in this order:

```
┌─────────────────────────────────────────────┐
│ Claude Code preset system prompt (built-in) │
├─────────────────────────────────────────────┤
│ Org persona (append)                        │  ← $ORG_DIR/CLAUDE.md
│ Organization-wide rules, shared policies    │    (loaded by loadOrgClaudeMd() when ORG_DIR is set)
├─────────────────────────────────────────────┤
│ User persona (project CLAUDE.md)            │  ← /data/memory/CLAUDE.md
│ Agent identity, user-specific instructions  │    (discovered by SDK via cwd)
└─────────────────────────────────────────────┘
```

Both files are optional. If `ORG_DIR` is not set or the file does not exist, no org overlay is applied. If neither persona exists, the agent runs with the default Claude Code system prompt.

This two-tier design mirrors NanoClaw's global + per-group CLAUDE.md pattern, adapted for PicoClaw's single-user model.

> **Deprecation note:** The previous convention of placing the org persona at `/data/memory/global/CLAUDE.md` is deprecated and no longer loaded. Use `$ORG_DIR/CLAUDE.md` with the `ORG_DIR` environment variable instead.

### File locations

| File | Purpose | Loaded by |
|------|---------|-----------|
| `/data/memory/CLAUDE.md` | User persona (identity, capabilities, rules) | SDK/CLI auto-discovery (`cwd` + `settingSources`) |
| `$ORG_DIR/CLAUDE.md` | Org persona overlay (shared policies) | `loadOrgClaudeMd()` → `systemPrompt.append` (requires `ORG_DIR` env var) |

The agent's working directory is `/data/memory`, so it can read and write any file under this path.

### Writing a persona

Create `/data/memory/CLAUDE.md` with the agent's identity, capabilities, and behavioral rules:

```markdown
# Pico

You are Pico, a helpful assistant that specializes in [your domain].

## Capabilities

- Answer questions about [topic]
- Search the web for current information
- Read and write files in the working directory
- Execute bash commands
- Schedule recurring tasks

## Communication Style

- Be concise and direct
- Use bullet points for lists
- Include code examples when relevant

## Tools

You have access to MCP tools:
- `mcp__picoclaw__send_message` — send a message immediately (useful during long tasks)
- `mcp__picoclaw__schedule_task` — create a scheduled task
- `mcp__picoclaw__list_tasks` — view existing tasks
```

### Persona best practices

1. **Be specific about the domain.** A focused persona produces better results than a generic one.
2. **Define output format.** If the agent's output will be parsed by downstream systems, specify the expected format.
3. **Set boundaries.** Clearly state what the agent should and should not do.
4. **List available MCP tools.** The agent performs better when it knows what tools are available.
5. **Let the agent organize its own workspace.** Don't prescribe a rigid directory hierarchy — the agent can create subdirectories as needed under `/data/memory/`.

### Org persona (optional)

For multi-user deployments, create `$ORG_DIR/CLAUDE.md` with organization-wide instructions:

```markdown
# Organization Policy

## Compliance

- Never disclose internal API endpoints or credentials
- Always include disclaimers when providing financial or medical information

## Output Standards

- Use ISO 8601 date format (YYYY-MM-DD)
- Include source attribution when citing external data
```

The org persona is appended to the system prompt before the user persona is loaded. This ensures organization-wide rules are always present regardless of the user's CLAUDE.md content.

In cloud deployments, the org persona is provisioned from shared storage (e.g., an organization-wide OSS bucket or NAS path) and mounted as the `ORG_DIR` volume.

### Org MCP servers (`managed-mcp.json`)

When `ORG_DIR` is set and `$ORG_DIR/managed-mcp.json` exists, PicoClaw copies it to `/etc/claude-code/managed-mcp.json` at startup. The Claude Code CLI auto-discovers managed MCP server configurations from this well-known path, making the servers available to the agent without any per-user configuration.

This is the recommended way to provision organization-wide MCP servers. The file follows the standard Claude Code managed MCP format:

```json
{
  "mcpServers": {
    "org-tools": {
      "type": "http",
      "url": "https://mcp.example.com/org-tools/mcp"
    }
  }
}
```

### Memory structure

Keep the memory volume simple and SDK-native. The agent creates subdirectories as needed:

```
/data/memory/
  CLAUDE.md              # User persona (recommended, not required)
  skills/                # User-created skills (auto-discovered, hot-reloadable)
  conversations/         # Archived transcripts (rare — see note below)
  [agent-managed files]  # The agent organizes its own workspace

$ORG_DIR/                # Org directory (set via ORG_DIR env var, optional)
  CLAUDE.md              # Org persona overlay (shared policies)
  managed-mcp.json       # Org MCP server definitions (optional)
  skills/                # Org skills (optional)
```

No prescriptive subdirectory structure is enforced. All `/data/*` volumes can be mounted as empty directories — the container creates the necessary internal structures automatically at startup.

> **Note on `conversations/`:** This directory is created on-demand by the PreCompact hook when context compaction occurs. In practice, compaction only fires within a single `query()` call when the conversation exceeds the context window — which rarely happens in PicoClaw's request-driven model where each HTTP request starts a fresh `query()`. Most deployments will never see files here.

> **Note on auto-memory:** Claude Code's built-in auto-memory feature (`MEMORY.md` auto-generation) is gated behind an internal CLI feature flag and is currently non-functional in SDK/non-interactive mode. `MEMORY.md` will not be auto-generated. If cross-session memory is needed, instruct the agent via the persona (`CLAUDE.md`) to explicitly read/write files in `/data/memory/`.

## Writing Skills

Skills extend the agent's capabilities without modifying PicoClaw's source code. PicoClaw supports a three-tier skill system with well-defined merge semantics.

### Skill tiers and merge strategy

Skills are loaded from three sources and merged at startup:

| Tier | Source | Override behavior |
|------|--------|-------------------|
| Built-in | Bundled with PicoClaw image | Base layer |
| Org | `$ORG_DIR/skills/` (when `ORG_DIR` is set) | Overrides built-in skills of the same name |
| User | `/data/memory/skills/` | **Additive only** — cannot override org or built-in skills of the same name; same-name skills are skipped |

The merge priority is: **built-in** → **org** (overrides built-in) → **user** (additive only). This ensures that organization-level skill policies cannot be bypassed by user-created skills.

User skills from `/data/memory/skills/` are pre-loaded at startup and can be hot-reloaded via `POST /admin/reload-skills` without restarting the container.

### Skill directory structure

```
/data/skills/              # Org skills (mounted, read-only)
  my-skill/
    SKILL.md               # Required: instructions for the agent
    [supporting files]     # Optional: templates, configs, examples

/data/memory/skills/       # User skills (read/write, hot-reloadable)
  my-custom-skill/
    SKILL.md
    [supporting files]
```

At container startup, skills from all tiers are synced to `.claude/skills/` where the Claude agent discovers them.

### SKILL.md format

A skill file contains instructions the agent follows. Use clear, structured markdown with YAML frontmatter:

```markdown
---
name: web-scraper
description: Scrape and summarize web pages on demand
---

# Web Scraper

## When to use this skill

When the user asks you to extract or summarize content from a specific URL.

## Instructions

1. Use `WebFetch` to retrieve the page content.
2. Parse the relevant text sections.
3. Summarize the key points in bullet form.
4. If the page is too large, extract the first 5000 characters.

## Output format

Return a structured summary:

- **Title**: Page title
- **URL**: Source URL
- **Summary**: 3-5 bullet points
- **Key data**: Any numbers, dates, or facts extracted
```

### Skill types

#### Type 1: Behavioral instructions

The simplest type. Teaches the agent a new capability through instructions alone.

```markdown
---
name: code-reviewer
description: Review code for common issues
---

# Code Reviewer

When asked to review code:

1. Check for security vulnerabilities (OWASP top 10)
2. Identify performance issues
3. Verify error handling patterns
4. Suggest simplifications
5. Format findings as a checklist
```

#### Type 2: Tool integration

Provides instructions for using external tools or APIs available in the container.

```markdown
---
name: python-data-analysis
description: Analyze data using Python pandas
---

# Python Data Analysis

The container has Python 3 with pandas, numpy, and matplotlib installed.

## When to use

When the user provides CSV/JSON data and asks for analysis.

## Instructions

1. Save the data to a temporary file in `/tmp/`.
2. Write a Python script using pandas to analyze it.
3. Run the script via Bash tool.
4. If visualization is needed, save charts as PNG to `/data/memory/charts/`.
5. Return the analysis results and chart paths.

## Example

```bash
python3 -c "
import pandas as pd
df = pd.read_csv('/tmp/data.csv')
print(df.describe())
print(df.groupby('category').mean())
"
```
```

#### Type 3: MCP tool documentation

Documents MCP tools the agent can use.

```markdown
---
name: task-management
description: Guide for using PicoClaw task scheduling
---

# Task Management

You can schedule recurring tasks using MCP tools.

## Available MCP tools

- `mcp__picoclaw__schedule_task` — Create a new scheduled task
  - `prompt`: What the task should do
  - `schedule_type`: "cron", "interval", or "once"
  - `schedule_value`: Cron expression, milliseconds, or ISO timestamp
  - `context_mode`: "group" (shared conversation) or "isolated" (fresh each time)

- `mcp__picoclaw__list_tasks` — List all scheduled tasks
- `mcp__picoclaw__pause_task` — Pause a task
- `mcp__picoclaw__resume_task` — Resume a paused task
- `mcp__picoclaw__cancel_task` — Delete a task

## Examples

Create a daily report at 9am:
```json
{
  "prompt": "Check the project status and write a summary",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "context_mode": "isolated"
}
```
```

### Skill authoring best practices

1. **One skill, one capability.** Keep skills focused. A skill that does too many things is harder to maintain.
2. **Use YAML frontmatter.** The `name` and `description` fields help the agent decide when to use the skill.
3. **Include examples.** Concrete examples help the agent apply the skill correctly.
4. **Specify output format.** If the skill produces structured output, define the expected format.
5. **Test with a running instance.** Mount the skill and verify the agent can follow the instructions:

```bash
docker run --rm -it \
  -v ./my-skill:/data/skills/my-skill \
  -e API_TOKEN=test -e ANTHROPIC_BASE_URL=https://api.anthropic.com -e ANTHROPIC_API_KEY=xxx \
  picoclaw:latest
```

## Skills Engine (Advanced)

PicoClaw includes a `skills-engine/` directory inherited from NanoClaw. This engine supports deterministic skill application with three-way merging, state tracking, and rollback — primarily used for skills that modify the PicoClaw source code itself (adding new channels, changing container configuration, etc.).

For most use cases, the simpler file-based skill approach described above (SKILL.md in `/data/skills/` or `/data/memory/skills/`) is sufficient and recommended.

### When to use the skills engine

- Adding a new communication channel to the source code
- Modifying the container configuration or Dockerfile
- Adding npm dependencies to the runtime
- Changes that require rebuilding the Docker image

### Skills engine workflow

```bash
# Initialize (first time only)
npx tsx skills-engine/src/index.ts init

# Apply a skill
npx tsx skills-engine/src/index.ts apply .claude/skills/add-telegram

# Check state
cat .nanoclaw/state.yaml
```

The engine tracks applied skills, file hashes, and structured outcomes in `.nanoclaw/state.yaml`, enabling safe application, conflict detection, and rollback.

## Runtime Environment

The PicoClaw container includes:

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22 | Runtime |
| Python 3 | System | Script execution, data analysis |
| pip packages | pandas, numpy, matplotlib, requests | Data processing |
| Chromium | System | Web browsing (agent-browser) |
| git | System | Version control operations |
| jq | System | JSON processing |
| Claude Code | Latest | CLI for agent SDK |

Skills can leverage any of these tools in their instructions.
