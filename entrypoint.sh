#!/bin/bash
set -euo pipefail

CLAUDE_HOME="/home/node/.claude"
SESSION_CLAUDE_DIR="/data/sessions/.claude"
SETTINGS_FILE="${CLAUDE_HOME}/settings.json"

mkdir -p /data/memory/global /data/memory/conversations /data/skills /data/store /data/sessions

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

SKILLS_SRC="/data/skills"
SKILLS_DST="${CLAUDE_HOME}/skills"
if [ -d "${SKILLS_SRC}" ]; then
  mkdir -p "${SKILLS_DST}"
  find "${SKILLS_DST}" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
  for dir in "${SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

exec node /app/dist/index.js "$@"
