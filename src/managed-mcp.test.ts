import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('managed-mcp', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadWithOrgDir(
    orgDir: string,
  ): Promise<typeof import('./managed-mcp.js')> {
    vi.stubEnv('ORG_DIR', orgDir);
    return import('./managed-mcp.js');
  }

  it('returns empty when ORG_DIR is not set', async () => {
    vi.stubEnv('ORG_DIR', '');
    const mod = await import('./managed-mcp.js');
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
    expect(mod.getManagedMcpNames()).toEqual([]);
  });

  it('parses valid managed-mcp.json with http and sse servers', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          finance: { type: 'http', url: 'http://example.com/mcp' },
          analytics: {
            type: 'sse',
            url: 'http://example.com/sse',
            headers: { Authorization: 'Bearer tok' },
          },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(servers).toEqual({
      finance: { type: 'http', url: 'http://example.com/mcp' },
      analytics: {
        type: 'sse',
        url: 'http://example.com/sse',
        headers: { Authorization: 'Bearer tok' },
      },
    });
    expect(mod.getManagedMcpNames()).toEqual(['finance', 'analytics']);
    expect(mod.getManagedMcpServers()).toBe(servers);
  });

  it('parses stdio server config', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { DEBUG: '1' },
          },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(servers).toEqual({
      local: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { DEBUG: '1' },
      },
    });
  });

  it('skips invalid entries and keeps valid ones', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { type: 'http', url: 'http://valid.com/mcp' },
          bad1: { type: 'http' },
          bad2: 'not-an-object',
          bad3: { type: 'stdio' },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(Object.keys(servers)).toEqual(['good']);
    expect(servers.good).toEqual({ type: 'http', url: 'http://valid.com/mcp' });
  });

  it('returns empty on malformed JSON', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(path.join(orgDir, 'managed-mcp.json'), '{invalid json');

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
  });

  it('returns empty when file does not exist', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    // No managed-mcp.json file

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
  });
});
