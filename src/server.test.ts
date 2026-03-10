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
  let stopSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    process.env.API_TOKEN = 'test-token';

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-http-'));

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
          result: 'mock-result [[PICOCLAW_SESSION_END]]',
          newSessionId: 'session-abc',
          lastAssistantUuid: 'assistant-abc',
        };
      },
    };
    stopSpy = vi.fn();

    const serverModule = await import('./server.js');
    app = serverModule.createServer(fakeEngine, {
      onStop: stopSpy,
    });
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
    expect(first.body.result).toContain('mock-result');
    expect(first.body.session_end_marker).toBe('[[PICOCLAW_SESSION_END]]');
    expect(first.body.session_end_marker_detected).toBe(true);

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

  it('lists conversations via GET /chat', async () => {
    // Create a conversation
    await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const list = await request(app)
      .get('/chat')
      .set('Authorization', 'Bearer test-token');

    expect(list.status).toBe(200);
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0].id).toMatch(/^conv-/);
  });

  it('returns messages via GET /chat/:id/messages', async () => {
    const first = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const conversationId = first.body.conversation_id as string;

    const messages = await request(app)
      .get(`/chat/${conversationId}/messages`)
      .set('Authorization', 'Bearer test-token');

    expect(messages.status).toBe(200);
    expect(messages.body.conversation_id).toBe(conversationId);
    expect(messages.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.body.messages[0].role).toBe('user');
  });

  it('deletes conversation via DELETE /chat/:id', async () => {
    const create = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const conversationId = create.body.conversation_id as string;

    const del = await request(app)
      .delete(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');

    expect(del.status).toBe(204);

    // Verify it's gone
    const get = await request(app)
      .get(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');
    expect(get.status).toBe(404);
  });

  it('returns 404 when deleting non-existent conversation', async () => {
    const del = await request(app)
      .delete('/chat/conv-nonexistent')
      .set('Authorization', 'Bearer test-token');

    expect(del.status).toBe(404);
  });

  it('returns 409 for concurrent requests to same conversation', async () => {
    const slowEngine: AgentRunner = {
      async run() {
        await new Promise((r) => setTimeout(r, 100));
        return {
          status: 'success',
          result: 'slow-result',
          newSessionId: 'session-slow',
          lastAssistantUuid: 'uuid-slow',
        };
      },
    };
    const serverModule = await import('./server.js');
    const slowApp = serverModule.createServer(slowEngine);

    // Create a conversation first
    const create = await request(slowApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'create' });
    const convId = create.body.conversation_id;

    // Fire two requests concurrently
    const [r1, r2] = await Promise.all([
      request(slowApp)
        .post('/chat')
        .set('Authorization', 'Bearer test-token')
        .send({ message: 'first', conversation_id: convId }),
      request(slowApp)
        .post('/chat')
        .set('Authorization', 'Bearer test-token')
        .send({ message: 'second', conversation_id: convId }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('accepts stop request and invokes shutdown callback', async () => {
    const response = await request(app)
      .post('/control/stop')
      .set('Authorization', 'Bearer test-token')
      .send({ reason: 'unit-test' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('stopping');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSpy).toHaveBeenCalledWith('unit-test');
  });
});
