import fs from 'fs';
import path from 'path';

import {
  BUILT_IN_SKILLS_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
  SKILLS_DIR,
} from './config.js';
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
 * Copy skill directories that do NOT already exist at the destination.
 * Used for user skills: they supplement but never override org or built-in skills.
 */
function syncDirectoryAdditive(sourceDir: string, destination: string): number {
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
    // Skip if skill already exists (from built-in or org tier).
    if (fs.existsSync(destinationPath)) {
      continue;
    }

    fs.cpSync(sourcePath, destinationPath, { recursive: true });
    count++;
  }
  return count;
}

/**
 * Sync skills from three tiers to .claude/skills/.
 *
 * Load order:
 *   1. BUILT_IN_SKILLS_DIR (bundled in image)
 *   2. SKILLS_DIR (org skills — authoritative, overrides built-in)
 *   3. USER_SKILLS_DIR (user skills — additive only, does NOT override org or built-in)
 */
export function syncSkills(): void {
  const destination = path.join(SESSIONS_DIR, '.claude', 'skills');
  fs.mkdirSync(destination, { recursive: true });

  // Clear destination so removed skills do not persist across reloads.
  for (const entry of fs.readdirSync(destination)) {
    const entryPath = path.join(destination, entry);
    if (fs.statSync(entryPath).isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }

  const builtInCount = syncDirectory(BUILT_IN_SKILLS_DIR, destination);
  const orgCount = syncDirectory(SKILLS_DIR, destination);
  const userCount = syncDirectoryAdditive(USER_SKILLS_DIR, destination);

  logger.info(
    { builtIn: builtInCount, org: orgCount, user: userCount },
    'Skills synced to .claude/skills/',
  );
}

export function getSkillsSummary(): {
  builtIn: string[];
  org: string[];
  user: string[];
  effective: string[];
} {
  const builtIn = listSkillNames(BUILT_IN_SKILLS_DIR);
  const org = listSkillNames(SKILLS_DIR);
  const user = listSkillNames(USER_SKILLS_DIR);
  const effective = [...new Set([...builtIn, ...org, ...user])].sort();
  return { builtIn, org, user, effective };
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
