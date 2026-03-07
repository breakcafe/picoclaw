import fs from 'fs';
import path from 'path';

import { PORT } from './config.js';
import { closeDatabase, initDatabase, syncDatabaseToVolume } from './db.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { ensureClaudeSettings, syncSkills } from './skills.js';

function ensureDataDirectories(): void {
  const directories = [
    '/data/memory',
    '/data/memory/global',
    '/data/memory/conversations',
    '/data/skills',
    '/data/store',
    '/data/sessions/.claude',
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

  const app = createServer();
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'NanoClaw Lite ready');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      syncDatabaseToVolume();
      closeDatabase();
    } catch (err) {
      logger.error({ err }, 'Failed to sync database on shutdown');
    }

    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start NanoClaw Lite');
  process.exit(1);
});
