import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Tests for skill sync logic.
 *
 * Config is read at import time (ESM imports are hoisted above module-scope
 * code), so we use vi.hoisted() to set env vars BEFORE config.ts evaluates.
 */

// vi.hoisted() runs before all imports — set env vars so config.ts and
// skills.ts read the correct temp paths when they evaluate at import time.
const dirs = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'picoclaw-skills-'));
  const builtInDir = _path.join(tmpDir, 'built-in-skills');
  const orgDir = _path.join(tmpDir, 'org-skills');
  const userDir = _path.join(tmpDir, 'user-skills');
  const sessionsDir = _path.join(tmpDir, 'sessions');
  const destination = _path.join(sessionsDir, '.claude', 'skills');

  process.env.BUILT_IN_SKILLS_DIR = builtInDir;
  process.env.SKILLS_DIR = orgDir;
  process.env.USER_SKILLS_DIR = userDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.MEMORY_DIR = _path.join(tmpDir, 'memory');

  return { tmpDir, builtInDir, orgDir, userDir, sessionsDir, destination };
});

import fs from 'fs';
import path from 'path';

import { syncSkills } from './skills.js';

function createSkill(baseDir: string, name: string, content?: string): void {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content || `# ${name}\n`);
}

function listEffective(): string[] {
  if (!fs.existsSync(dirs.destination)) return [];
  return fs
    .readdirSync(dirs.destination)
    .filter((e) => fs.statSync(path.join(dirs.destination, e)).isDirectory())
    .sort();
}

function clearAllSources(): void {
  for (const dir of [dirs.builtInDir, dirs.orgDir, dirs.userDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
  }
}

describe('syncSkills', () => {
  beforeAll(() => {
    fs.mkdirSync(dirs.builtInDir, { recursive: true });
    fs.mkdirSync(dirs.orgDir, { recursive: true });
    fs.mkdirSync(dirs.userDir, { recursive: true });
    fs.mkdirSync(dirs.destination, { recursive: true });
  });

  afterAll(() => {
    if (dirs.tmpDir) {
      fs.rmSync(dirs.tmpDir, { recursive: true, force: true });
    }
    delete process.env.BUILT_IN_SKILLS_DIR;
    delete process.env.SKILLS_DIR;
    delete process.env.USER_SKILLS_DIR;
    delete process.env.SESSIONS_DIR;
    delete process.env.MEMORY_DIR;
  });

  it('syncs built-in, org, and user skills to destination', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'builtin-a');
    createSkill(dirs.orgDir, 'org-b');
    createSkill(dirs.userDir, 'user-c');

    syncSkills();

    expect(listEffective()).toEqual(['builtin-a', 'org-b', 'user-c']);
  });

  it('org skills override built-in skills of the same name', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'shared-skill', '# built-in version\n');
    createSkill(dirs.orgDir, 'shared-skill', '# org version\n');

    syncSkills();

    const content = fs.readFileSync(
      path.join(dirs.destination, 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toBe('# org version\n');
  });

  it('user skills do not override org or built-in skills', () => {
    clearAllSources();
    createSkill(dirs.orgDir, 'shared-skill', '# org version\n');
    createSkill(dirs.userDir, 'shared-skill', '# user version\n');

    syncSkills();

    const content = fs.readFileSync(
      path.join(dirs.destination, 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toBe('# org version\n');
  });

  it('removes deleted skills on reload (full reconciliation)', () => {
    clearAllSources();
    createSkill(dirs.userDir, 'temp-skill');
    syncSkills();
    expect(listEffective()).toContain('temp-skill');

    // Delete the source skill
    fs.rmSync(path.join(dirs.userDir, 'temp-skill'), { recursive: true });
    syncSkills();

    expect(listEffective()).not.toContain('temp-skill');
  });

  it('reload clears orphaned skills not in any source', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'alpha');
    syncSkills();
    const firstSync = listEffective();

    // Manually inject an orphan skill into destination
    createSkill(dirs.destination, 'orphan');
    expect(listEffective()).toContain('orphan');

    // Reload should remove the orphan
    syncSkills();
    expect(listEffective()).toEqual(firstSync);
  });

  it('handles missing source directories gracefully', () => {
    // Remove all source dirs entirely
    for (const dir of [dirs.builtInDir, dirs.orgDir, dirs.userDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    syncSkills();

    expect(listEffective()).toEqual([]);

    // Recreate for subsequent tests
    fs.mkdirSync(dirs.builtInDir, { recursive: true });
    fs.mkdirSync(dirs.orgDir, { recursive: true });
    fs.mkdirSync(dirs.userDir, { recursive: true });
  });
});
