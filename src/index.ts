import fs from 'fs';
import path from 'path';

import {
  ANTHROPIC_BASE_URL,
  MEMORY_DIR,
  PORT,
  SESSIONS_DIR,
  SKILLS_DIR,
  STORE_DIR,
} from './config.js';
import { closeDatabase, initDatabase, syncDatabaseToVolume } from './db.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { ensureClaudeSettings, syncSkills } from './skills.js';

function ensureDataDirectories(): void {
  const directories = [
    MEMORY_DIR,
    SKILLS_DIR,
    STORE_DIR,
    path.join(SESSIONS_DIR, '.claude'),
  ];

  for (const directory of directories) {
    fs.mkdirSync(path.resolve(directory), { recursive: true });
  }
}

async function main(): Promise<void> {
  ensureDataDirectories();
  initDatabase();
  ensureClaudeSettings();
  syncSkills();

  let isShuttingDown = false;
  let server: ReturnType<ReturnType<typeof createServer>['listen']>;

  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      logger.info({ signal }, 'Shutdown already in progress');
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    try {
      syncDatabaseToVolume();
      closeDatabase();
    } catch (err) {
      logger.error({ err }, 'Failed to sync database on shutdown');
    }

    server.close(() => process.exit(0));
  };

  const app = createServer(undefined, {
    onStop: (reason: string) => shutdown(`API_STOP:${reason}`),
  });
  server = app.listen(PORT, () => {
    if (ANTHROPIC_BASE_URL) {
      logger.info(
        { baseUrl: ANTHROPIC_BASE_URL },
        'Using custom Anthropic base URL',
      );
    }
    logger.info({ port: PORT }, 'PicoClaw ready');
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start PicoClaw');
  process.exit(1);
});
