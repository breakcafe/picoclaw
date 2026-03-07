import fs from 'fs';
import os from 'os';
import path from 'path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunner } from './agent-engine.js';

describe('http server', () => {
  let closeDatabase: (() => void) | undefined;
  let resetDatabase: (() => void) | undefined;
  let app: import('express').Express;
  let fakeEngine: AgentRunner;

  beforeEach(async () => {
    vi.resetModules();
    process.env.API_TOKEN = 'test-token';

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-http-'));

    const dbModule = await import('./db.js');
    dbModule.initDatabase({
      persistentDbPath: path.join(rootDir, 'store', 'messages.db'),
      localDbPath: path.join(rootDir, 'tmp', 'messages.db'),
      forceReinitialize: true,
    });

    closeDatabase = dbModule.closeDatabase;
    resetDatabase = dbModule._resetDatabaseForTests;

    fakeEngine = {
      async run() {
        return {
          status: 'success',
          result: 'mock-result',
          newSessionId: 'session-abc',
          lastAssistantUuid: 'assistant-abc',
        };
      },
    };

    const serverModule = await import('./server.js');
    app = serverModule.createServer(fakeEngine);
  });

  afterEach(() => {
    closeDatabase?.();
    resetDatabase?.();
  });

  it('returns health without auth', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('rejects chat request without bearer token', async () => {
    const response = await request(app)
      .post('/chat')
      .send({ message: 'hello' });
    expect(response.status).toBe(401);
  });

  it('creates and resumes conversation through /chat', async () => {
    const first = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'first turn', sender: 'u1', sender_name: 'User' });

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('success');
    expect(first.body.conversation_id).toMatch(/^conv-/);
    expect(first.body.result).toBe('mock-result');

    const conversationId = first.body.conversation_id as string;

    const second = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'second turn',
        conversation_id: conversationId,
        sender: 'u1',
        sender_name: 'User',
      });

    expect(second.status).toBe(200);
    expect(second.body.conversation_id).toBe(conversationId);

    const status = await request(app)
      .get(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');

    expect(status.status).toBe(200);
    expect(status.body.message_count).toBeGreaterThanOrEqual(4);
  });

  it('creates and lists tasks', async () => {
    const response = await request(app)
      .post('/task')
      .set('Authorization', 'Bearer test-token')
      .send({
        prompt: 'do work',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^task-/);

    const list = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer test-token');

    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
  });
});
