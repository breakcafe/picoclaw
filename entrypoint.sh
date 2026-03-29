#!/bin/bash
set -euo pipefail

# Enable V8 compile cache — caches bytecode for cli.js (11.5 MB) and other
# large JS files, reducing per-request CLI subprocess parse time by ~200-400ms.
# Node.js 22+ feature; harmless no-op on older versions.
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/node-compile-cache}"
mkdir -p "${NODE_COMPILE_CACHE}"

MEMORY_DIR="${MEMORY_DIR:-/data/memory}"
CLAUDE_HOME="/home/node/.claude"
SESSION_CLAUDE_DIR="${MEMORY_DIR}/.claude"
SETTINGS_FILE="${CLAUDE_HOME}/settings.json"

mkdir -p "${MEMORY_DIR}" /data/store

# Ensure persistent .claude directory exists and symlink home to it.
# This must be unconditional so empty mounted volumes get the needed
# structure on first boot.
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

# ── Skill directories ────────────────────────────────────────────
# Skill sync (three-tier merge + runtime skill persist) is handled
# entirely by src/index.ts syncSkills() at Node.js startup.
# entrypoint.sh only ensures the directories exist.
mkdir -p "${MEMORY_DIR}/.claude/skills" "${MEMORY_DIR}/skills"

# ── Auto-memory symlink ─────────────────────────────────────────
# Link Claude Code auto-memory directory to the actual memory volume.
# The SDK writes auto-memory to $HOME/.claude/projects/<cwd-slug>/memory/
# but the agent's cwd is /data/memory. Without this link, auto-memory
# writes go to an isolated directory that the agent never sees.
# NOTE: As of SDK 0.2.34, auto-memory is gated behind an internal feature
# flag (tengu_herring_clock, default false) and is non-functional in
# SDK/non-interactive mode. This symlink is a forward-compatibility measure.
PROJECT_SLUG=$(echo "${MEMORY_DIR}" | sed 's|/|-|g')
AUTO_MEMORY_DIR="${CLAUDE_HOME}/projects/${PROJECT_SLUG}/memory"

# Skip symlink when AUTO_MEMORY_DIR is inside MEMORY_DIR (merged mode → circular).
case "${AUTO_MEMORY_DIR}" in
  "${MEMORY_DIR}"/*)
    ;;  # Skip — would be circular
  *)
    if [ -d "${AUTO_MEMORY_DIR}" ] && [ ! -L "${AUTO_MEMORY_DIR}" ]; then
      # Move any existing auto-memory content to the real volume
      if [ -f "${AUTO_MEMORY_DIR}/MEMORY.md" ]; then
        cp -n "${AUTO_MEMORY_DIR}/MEMORY.md" "${MEMORY_DIR}/MEMORY.md" 2>/dev/null || true
      fi
      rm -rf "${AUTO_MEMORY_DIR}"
    fi
    mkdir -p "$(dirname "${AUTO_MEMORY_DIR}")"
    ln -sf "${MEMORY_DIR}" "${AUTO_MEMORY_DIR}"
    ;;
esac

exec node /app/dist/index.js "$@"
