# Contributing to PicoClaw

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, enhancements. These should be skills mounted via `$ORG_DIR/skills/` or `/data/memory/skills/`.

## Skills

A skill is a directory that teaches the Claude agent new capabilities at runtime. Skills are loaded via volume mount — no source code changes required. Org skills go in `$ORG_DIR/skills/`; user skills go in `/data/memory/skills/`.

Each skill directory should contain:

- `SKILL.md` — instructions the agent follows to use the skill (required)
- Supporting files as needed (templates, configs, examples)

### Why?

PicoClaw's core is intentionally minimal. Skills let operators extend the agent's capabilities without modifying the runtime. Different deployments can mount different skill sets for different use cases.

### Testing

Test your skill by mounting it into a running PicoClaw container and verifying the agent can follow the instructions in `SKILL.md`.

```bash
# Mount your skill alongside existing skills
docker run ... -v ./my-skill:/data/memory/skills/my-skill picoclaw:latest
```

## Persona (CLAUDE.md)

The agent's persona is defined by `/data/memory/CLAUDE.md`. Persona changes are not source code changes — they are mounted at runtime.

See `docs/SKILLS_AND_PERSONA_GUIDE.md` for authoring instructions.
