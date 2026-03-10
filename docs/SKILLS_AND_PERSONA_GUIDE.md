# Skills and Persona Authoring Guide

How to customize PicoClaw's behavior by writing skills and defining agent personas.

## Persona Configuration

The agent persona is defined by `CLAUDE.md` files in the memory volume.

### File locations

| File | Purpose | Loaded by |
|------|---------|-----------|
| `/data/memory/CLAUDE.md` | Main persona definition | Agent engine (appended to system prompt) |
| `/data/memory/global/CLAUDE.md` | Global shared context | Agent engine (additional directory) |

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

## Memory

- Store important notes in /data/memory/notes/
- Check /data/memory/conversations/ for prior context
- Maintain an index file for large knowledge bases

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
4. **Reference memory paths.** Tell the agent where to find and store persistent data.
5. **List available MCP tools.** The agent performs better when it knows what tools are available.

### Global memory

Files in `/data/memory/global/` are accessible as additional context. Use this for shared knowledge that should persist across conversations:

```
/data/memory/
  CLAUDE.md              # Persona definition
  global/
    CLAUDE.md            # Global context and rules
    contacts.md          # Shared contact directory
    project-notes.md     # Persistent project knowledge
  conversations/         # Archived transcripts (auto-generated)
    2026-03-10-topic.md
```

## Writing Skills

Skills extend the agent's capabilities without modifying PicoClaw's source code. They are directories mounted at `/data/skills/`.

### Skill directory structure

```
/data/skills/
  my-skill/
    SKILL.md             # Required: instructions for the agent
    [supporting files]   # Optional: templates, configs, examples
```

At container startup, skills are synced to `.claude/skills/` where the Claude agent discovers them.

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
  -e API_TOKEN=test -e ANTHROPIC_API_KEY=xxx \
  picoclaw:latest
```

## Skills Engine (Advanced)

PicoClaw includes a `skills-engine/` directory inherited from NanoClaw. This engine supports deterministic skill application with three-way merging, state tracking, and rollback — primarily used for skills that modify the PicoClaw source code itself (adding new channels, changing container configuration, etc.).

For most use cases, the simpler file-based skill approach described above (SKILL.md in `/data/skills/`) is sufficient and recommended.

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
