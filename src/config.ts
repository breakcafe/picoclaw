const parseIntWithDefault = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const APP_VERSION = process.env.APP_VERSION || '1.0.0';
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Pico';
export const API_TOKEN = process.env.API_TOKEN || '';

export const PORT = parseIntWithDefault(process.env.PORT, 9000);
export const MAX_EXECUTION_MS = parseIntWithDefault(
  process.env.MAX_EXECUTION_MS,
  300_000,
);
export const SESSION_END_MARKER =
  process.env.SESSION_END_MARKER || '[[PICOCLAW_SESSION_END]]';

export const STORE_DIR = process.env.STORE_DIR || '/data/store';
export const MEMORY_DIR = process.env.MEMORY_DIR || '/data/memory';
export const SKILLS_DIR = process.env.SKILLS_DIR || '/data/skills';
export const SESSIONS_DIR = process.env.SESSIONS_DIR || '/data/sessions';

export const LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || '/tmp/messages.db';

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
