#!/bin/bash
set -euo pipefail

CLAUDE_HOME="/home/node/.claude"
SESSION_CLAUDE_DIR="/data/sessions/.claude"
SETTINGS_FILE="${CLAUDE_HOME}/settings.json"

mkdir -p /data/memory /data/store /data/sessions

# Ensure persistent .claude directory exists and symlink home to it.
# This must be unconditional so empty mounted /data/sessions volumes
# get the needed structure on first boot.
mkdir -p "${SESSION_CLAUDE_DIR}"
rm -rf "${CLAUDE_HOME}"
ln -sf "${SESSION_CLAUDE_DIR}" "${CLAUDE_HOME}"
if [ ! -f "${SETTINGS_FILE}" ]; then
  cat > "${SETTINGS_FILE}" << 'JSON'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
JSON
fi

# ── Org directory setup ──────────────────────────────────────────
# When ORG_DIR is set, copy managed-mcp.json to the Claude Code CLI
# system path so the CLI subprocess auto-discovers org MCP servers.
ORG_DIR="${ORG_DIR:-}"
if [ -n "${ORG_DIR}" ] && [ -d "${ORG_DIR}" ]; then
  if [ -f "${ORG_DIR}/managed-mcp.json" ]; then
    mkdir -p /etc/claude-code
    cp "${ORG_DIR}/managed-mcp.json" /etc/claude-code/managed-mcp.json
  fi
fi

# ── Three-tier skill sync ────────────────────────────────────────
# Load order: built-in → org (authoritative) → user (additive only)
SKILLS_DST="${CLAUDE_HOME}/skills"
mkdir -p "${SKILLS_DST}"
find "${SKILLS_DST}" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

# 1. Built-in skills (bundled in image)
BUILTIN_SRC="/app/built-in-skills"
if [ -d "${BUILTIN_SRC}" ]; then
  for dir in "${BUILTIN_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

# 2. Org skills (from ORG_DIR or SKILLS_DIR fallback — overrides built-in)
if [ -n "${ORG_DIR}" ] && [ -d "${ORG_DIR}/skills" ]; then
  SKILLS_SRC="${ORG_DIR}/skills"
elif [ -n "${SKILLS_DIR:-}" ] && [ -d "${SKILLS_DIR:-}" ]; then
  SKILLS_SRC="${SKILLS_DIR}"
elif [ -d "/data/skills" ]; then
  SKILLS_SRC="/data/skills"
else
  SKILLS_SRC=""
fi

if [ -n "${SKILLS_SRC}" ]; then
  for dir in "${SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

# 3. User skills (additive only — skip skills that already exist)
USER_SKILLS_SRC="${USER_SKILLS_DIR:-/data/memory/skills}"
if [ -d "${USER_SKILLS_SRC}" ]; then
  for dir in "${USER_SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      skill_name="$(basename "${dir}")"
      if [ ! -d "${SKILLS_DST}/${skill_name}" ]; then
        cp -r "${dir}" "${SKILLS_DST}/${skill_name}"
      fi
    fi
  done
fi

# ── Auto-memory symlink ─────────────────────────────────────────
# Link Claude Code auto-memory directory to the actual memory volume.
# The SDK writes auto-memory to $HOME/.claude/projects/<cwd-slug>/memory/
# but the agent's cwd is /data/memory. Without this link, auto-memory
# writes go to an isolated directory that the agent never sees.
# NOTE: As of SDK 0.2.34, auto-memory is gated behind an internal feature
# flag (tengu_herring_clock, default false) and is non-functional in
# SDK/non-interactive mode. This symlink is a forward-compatibility measure.
MEMORY_DIR="${MEMORY_DIR:-/data/memory}"
PROJECT_SLUG=$(echo "${MEMORY_DIR}" | sed 's|/|-|g')
AUTO_MEMORY_DIR="${CLAUDE_HOME}/projects/${PROJECT_SLUG}/memory"
if [ -d "${AUTO_MEMORY_DIR}" ] && [ ! -L "${AUTO_MEMORY_DIR}" ]; then
  # Move any existing auto-memory content to the real volume
  if [ -f "${AUTO_MEMORY_DIR}/MEMORY.md" ]; then
    cp -n "${AUTO_MEMORY_DIR}/MEMORY.md" "${MEMORY_DIR}/MEMORY.md" 2>/dev/null || true
  fi
  rm -rf "${AUTO_MEMORY_DIR}"
fi
mkdir -p "$(dirname "${AUTO_MEMORY_DIR}")"
ln -sf "${MEMORY_DIR}" "${AUTO_MEMORY_DIR}"

exec node /app/dist/index.js "$@"
