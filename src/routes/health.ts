import { Router } from 'express';

import { APP_VERSION, MAX_EXECUTION_MS } from '../config.js';

export function healthRoutes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      version: APP_VERSION,
      max_execution_ms: MAX_EXECUTION_MS,
    });
  });

  return router;
}
