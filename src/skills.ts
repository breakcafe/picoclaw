import fs from 'fs';
import path from 'path';

import { MEMORY_DIR, SESSIONS_DIR, SKILLS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * User skills directory: lives inside the user's private memory volume
 * so user-created skills persist across container restarts.
 */
const USER_SKILLS_DIR =
  process.env.USER_SKILLS_DIR || path.join(MEMORY_DIR, 'skills');

function syncDirectory(sourceDir: string, destination: string): number {
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  let count = 0;
  for (const entry of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    if (!fs.statSync(sourcePath).isDirectory()) {
      continue;
    }

    const destinationPath = path.join(destination, entry);
    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
    count++;
  }
  return count;
}

/**
 * Sync skills from shared and user directories to .claude/skills/.
 *
 * Load order (later entries override earlier):
 *   1. SKILLS_DIR (shared/global skills — typically read-only mount)
 *   2. USER_SKILLS_DIR (user-created skills — in user's private volume)
 *
 * This means user skills can override shared skills of the same name.
 */
export function syncSkills(): void {
  const destination = path.join(SESSIONS_DIR, '.claude', 'skills');
  fs.mkdirSync(destination, { recursive: true });

  const sharedCount = syncDirectory(SKILLS_DIR, destination);
  const userCount = syncDirectory(USER_SKILLS_DIR, destination);

  logger.info(
    { shared: sharedCount, user: userCount },
    'Skills synced to .claude/skills/',
  );
}

export function getSkillsSummary(): {
  shared: string[];
  user: string[];
  effective: string[];
} {
  const shared = listSkillNames(SKILLS_DIR);
  const user = listSkillNames(USER_SKILLS_DIR);
  const effective = [...new Set([...shared, ...user])].sort();
  return { shared, user, effective };
}

function listSkillNames(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory())
    .sort();
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
