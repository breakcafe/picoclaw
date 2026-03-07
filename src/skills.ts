import fs from 'fs';
import path from 'path';

import { SESSIONS_DIR, SKILLS_DIR } from './config.js';

export function syncSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    return;
  }

  const destination = path.join(SESSIONS_DIR, '.claude', 'skills');
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const sourcePath = path.join(SKILLS_DIR, entry);
    if (!fs.statSync(sourcePath).isDirectory()) {
      continue;
    }

    const destinationPath = path.join(destination, entry);
    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

export function ensureClaudeSettings(): void {
  const claudeDir = path.join(SESSIONS_DIR, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    return;
  }

  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ),
  );
}
