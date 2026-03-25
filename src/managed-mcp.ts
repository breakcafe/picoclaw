import fs from 'fs';
import path from 'path';

import { McpServerConfig } from './agent-engine.js';
import { ORG_DIR } from './config.js';
import { logger } from './logger.js';

let cachedServers: Record<string, McpServerConfig> = {};

/**
 * Validate a single MCP server config entry.
 * Returns a typed McpServerConfig or null if invalid.
 * Shared by managed-mcp loading and per-request validation.
 */
export function validateSingleMcpServer(
  config: unknown,
): McpServerConfig | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null;
  }

  const cfg = config as Record<string, unknown>;
  const type = (cfg.type as string) || 'http';

  if (type === 'http' || type === 'sse') {
    if (typeof cfg.url !== 'string' || !cfg.url) {
      return null;
    }
    const entry: {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    } = { type, url: cfg.url };
    if (
      cfg.headers &&
      typeof cfg.headers === 'object' &&
      !Array.isArray(cfg.headers)
    ) {
      entry.headers = cfg.headers as Record<string, string>;
    }
    return entry;
  }

  if (type === 'stdio') {
    if (typeof cfg.command !== 'string' || !cfg.command) {
      return null;
    }
    const entry: {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    } = { type: 'stdio', command: cfg.command };
    if (Array.isArray(cfg.args)) {
      entry.args = cfg.args as string[];
    }
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      entry.env = cfg.env as Record<string, string>;
    }
    return entry;
  }

  return null;
}

/**
 * Read and cache MCP server configs from $ORG_DIR/managed-mcp.json.
 * Call once at startup. Uses the same format as Claude Code managed-mcp.json:
 * { "mcpServers": { "name": { "type": "http", "url": "..." } } }
 */
export function loadManagedMcpServers(): Record<string, McpServerConfig> {
  cachedServers = {};
  if (!ORG_DIR) {
    return cachedServers;
  }

  const filePath = path.join(ORG_DIR, 'managed-mcp.json');
  if (!fs.existsSync(filePath)) {
    return cachedServers;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw?.mcpServers && typeof raw.mcpServers === 'object') {
      for (const [name, config] of Object.entries(raw.mcpServers)) {
        if (name === 'picoclaw') {
          logger.warn(
            { server: name },
            'managed-mcp.json: "picoclaw" is a reserved name and was skipped — the built-in picoclaw server cannot be overridden',
          );
          continue;
        }
        const validated = validateSingleMcpServer(config);
        if (validated) {
          cachedServers[name] = validated;
        } else {
          logger.warn(
            { server: name },
            'Skipped invalid server in managed-mcp.json',
          );
        }
      }
    }
  } catch {
    logger.warn('Failed to parse managed-mcp.json');
  }

  return cachedServers;
}

/** Return cached managed MCP server configs (full config objects). */
export function getManagedMcpServers(): Record<string, McpServerConfig> {
  return cachedServers;
}

/** Return cached managed MCP server names. */
export function getManagedMcpNames(): string[] {
  return Object.keys(cachedServers);
}
