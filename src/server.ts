import express, { Express, NextFunction, Request, Response } from 'express';

import { AgentEngine, AgentRunner } from './agent-engine.js';
import { syncDatabaseToVolume } from './db.js';
import { logger } from './logger.js';
import { authMiddleware } from './middleware/auth.js';
import { chatRoutes } from './routes/chat.js';
import { controlRoutes } from './routes/control.js';
import { healthRoutes } from './routes/health.js';
import { taskRoutes } from './routes/task.js';

export interface ServerOptions {
  onStop?: (reason: string) => Promise<void> | void;
}

export function createServer(
  agentEngine: AgentRunner = new AgentEngine(),
  options: ServerOptions = {},
): Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      try {
        syncDatabaseToVolume();
      } catch (err) {
        logger.error({ err }, 'Failed to sync database to volume');
      }
    });
    next();
  });

  app.use('/health', healthRoutes());

  app.use(authMiddleware);
  app.use('/chat', chatRoutes(agentEngine));
  app.use(taskRoutes(agentEngine));
  app.use('/control', controlRoutes({ onStop: options.onStop }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}
