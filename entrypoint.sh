#!/bin/bash
set -euo pipefail

CLAUDE_HOME="/home/node/.claude"
SESSION_CLAUDE_DIR="/data/sessions/.claude"
SETTINGS_FILE="${CLAUDE_HOME}/settings.json"

mkdir -p /data/memory /data/skills /data/store /data/sessions

if [ -d "${SESSION_CLAUDE_DIR}" ]; then
  rm -rf "${CLAUDE_HOME}"
  ln -sf "${SESSION_CLAUDE_DIR}" "${CLAUDE_HOME}"
fi

mkdir -p "${CLAUDE_HOME}"
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

# Three-tier skill sync: built-in → shared → user (each overrides previous)
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

# 2. Shared skills (read-only mount)
SKILLS_SRC="/data/skills"
if [ -d "${SKILLS_SRC}" ]; then
  for dir in "${SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

# 3. User skills (user's private volume, highest priority)
USER_SKILLS_SRC="${USER_SKILLS_DIR:-/data/memory/skills}"
if [ -d "${USER_SKILLS_SRC}" ]; then
  for dir in "${USER_SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

exec node /app/dist/index.js "$@"
