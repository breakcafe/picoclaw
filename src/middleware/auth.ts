import { NextFunction, Request, Response } from 'express';

import { API_TOKEN } from '../config.js';

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!API_TOKEN) {
    res.status(500).json({ error: 'API_TOKEN is not configured' });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token || token !== API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
