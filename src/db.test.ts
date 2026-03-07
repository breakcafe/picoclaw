import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetDatabaseForTests,
  closeDatabase,
  consumeOutboundMessages,
  createConversation,
  initDatabase,
  queueOutboundMessage,
  storeConversationMessage,
  getPromptMessages,
  syncDatabaseToVolume,
} from './db.js';

function createTempPaths(): {
  rootDir: string;
  persistentPath: string;
  localPath: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-'));
  return {
    rootDir,
    persistentPath: path.join(rootDir, 'store', 'messages.db'),
    localPath: path.join(rootDir, 'tmp', 'messages.db'),
  };
}

afterEach(() => {
  closeDatabase();
  _resetDatabaseForTests();
});

describe('db', () => {
  it('stores conversation messages and renders prompt history', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-1');
    storeConversationMessage({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      sender: 'u1',
      senderName: 'User 1',
      content: 'hello',
      createdAt: '2026-03-08T10:00:00.000Z',
    });

    const promptMessages = getPromptMessages('conv-1');
    expect(promptMessages).toHaveLength(1);
    expect(promptMessages[0]).toMatchObject({
      id: 'msg-1',
      sender_name: 'User 1',
      content: 'hello',
    });
  });

  it('consumes outbound messages only once', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-2');
    queueOutboundMessage('conv-2', 'first');
    queueOutboundMessage('conv-2', 'second');

    const firstRead = consumeOutboundMessages('conv-2');
    expect(firstRead.map((item) => item.text)).toEqual(['first', 'second']);

    const secondRead = consumeOutboundMessages('conv-2');
    expect(secondRead).toEqual([]);
  });

  it('syncs local db to persistent volume path', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-3');
    syncDatabaseToVolume();

    expect(fs.existsSync(paths.persistentPath)).toBe(true);
  });
});
