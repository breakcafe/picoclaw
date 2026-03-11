import { randomUUID } from 'crypto';

import { Request, Response, Router } from 'express';

import {
  AgentRunner,
  McpServerConfig,
  StreamCallbacks,
} from '../agent-engine.js';
import {
  ASSISTANT_NAME,
  MAX_EXECUTION_MS,
  SESSION_END_MARKER,
  TIMEZONE,
} from '../config.js';
import {
  ConversationBusyError,
  acquireConversationLock,
} from '../conversation-lock.js';
import {
  consumeOutboundMessages,
  createConversation,
  deleteConversation,
  ensureConversation,
  getAllConversations,
  getConversation,
  getConversationMessages,
  getPromptMessages,
  setConversationStatus,
  storeConversationMessage,
  updateConversationSession,
} from '../db.js';
import { logger } from '../logger.js';
import { formatMessages, formatOutbound } from '../router.js';

interface ChatRequestBody {
  message?: string;
  conversation_id?: string;
  sender?: string;
  sender_name?: string;
  stream?: boolean;
  max_execution_ms?: number;
  thinking?: boolean;
  max_thinking_tokens?: number;
  show_tool_use?: boolean;
  mcp_servers?: Record<string, McpServerConfig>;
}

function getExecutionTimeout(ms?: number): number {
  if (!ms || !Number.isFinite(ms) || ms <= 0) {
    return MAX_EXECUTION_MS;
  }

  return Math.min(ms, MAX_EXECUTION_MS);
}

function writeSseEvent(res: Response, event: string, payload: object): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function resolveConversation(body: ChatRequestBody): {
  id: string;
  isNew: boolean;
} {
  if (!body.conversation_id) {
    return { id: `conv-${randomUUID()}`, isNew: true };
  }

  return { id: body.conversation_id, isNew: false };
}

function validateMcpServers(
  raw: unknown,
): Record<string, McpServerConfig> | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      continue;
    }

    const cfg = config as Record<string, unknown>;
    const type = (cfg.type as string) || 'http';

    if (type === 'http' || type === 'sse') {
      if (typeof cfg.url !== 'string' || !cfg.url) {
        continue;
      }
      const entry: {
        type: 'http' | 'sse';
        url: string;
        headers?: Record<string, string>;
      } = {
        type,
        url: cfg.url,
      };
      if (
        cfg.headers &&
        typeof cfg.headers === 'object' &&
        !Array.isArray(cfg.headers)
      ) {
        entry.headers = cfg.headers as Record<string, string>;
      }
      result[name] = entry;
    } else if (type === 'stdio') {
      if (typeof cfg.command !== 'string' || !cfg.command) {
        continue;
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
      result[name] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function containsSessionEndMarker(text: string | null | undefined): boolean {
  if (!SESSION_END_MARKER) {
    return false;
  }

  return Boolean(text && text.includes(SESSION_END_MARKER));
}

export function chatRoutes(agentEngine: AgentRunner): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = (req.body || {}) as ChatRequestBody;
    const message = body.message?.trim();

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const { id: conversationId, isNew } = resolveConversation(body);
    const existingConversation = getConversation(conversationId);
    if (!isNew && !existingConversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    const conversation = isNew
      ? createConversation(conversationId)
      : ensureConversation(conversationId);

    const userMessageId = `msg-${randomUUID()}`;
    const sender = body.sender?.trim() || 'user';
    const senderName = body.sender_name?.trim() || sender;

    storeConversationMessage({
      id: userMessageId,
      conversationId,
      role: 'user',
      sender,
      senderName,
      content: message,
    });

    const promptMessages = getPromptMessages(conversationId);
    const prompt = formatMessages(promptMessages, TIMEZONE);

    const executionTimeout = getExecutionTimeout(body.max_execution_ms);
    const stream = body.stream === true;
    const enableThinking = body.thinking === true;
    const maxThinkingTokens =
      enableThinking && body.max_thinking_tokens && body.max_thinking_tokens > 0
        ? body.max_thinking_tokens
        : enableThinking
          ? 10000
          : undefined;
    const showToolUse = body.show_tool_use === true;
    const mcpServers = validateMcpServers(body.mcp_servers);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      writeSseEvent(res, 'start', {
        conversation_id: conversationId,
        message_id: userMessageId,
      });
    }

    let releaseLock: (() => void) | undefined;
    const startedAt = Date.now();
    const chunkBuffer: string[] = [];

    try {
      releaseLock = await acquireConversationLock(conversationId, {
        wait: false,
      });
      setConversationStatus(conversationId, 'running');

      const streamCallbacks: StreamCallbacks = {
        onChunk: async (chunkText: string) => {
          const formatted = formatOutbound(chunkText);
          if (!formatted) {
            return;
          }

          chunkBuffer.push(formatted);
          if (stream) {
            writeSseEvent(res, 'chunk', { text: formatted });
          }
        },
        onThinking:
          stream && enableThinking
            ? async (text: string) => {
                writeSseEvent(res, 'thinking', { text });
              }
            : undefined,
        onToolUse:
          stream && showToolUse
            ? async (tool: string, input: unknown) => {
                writeSseEvent(res, 'tool_use', { tool, input });
              }
            : undefined,
      };

      const output = await agentEngine.run(
        {
          prompt,
          conversationId,
          sessionId: conversation.session_id,
          resumeAt: conversation.last_assistant_uuid,
          timeoutMs: executionTimeout,
          assistantName: ASSISTANT_NAME,
          maxThinkingTokens,
          showToolUse,
          mcpServers: mcpServers ?? undefined,
        },
        streamCallbacks,
      );

      const finalResult = formatOutbound(
        output.result || chunkBuffer.join('').trim(),
      );

      let assistantMessageId: string | null = null;
      if (finalResult) {
        assistantMessageId = `msg-${randomUUID()}`;
        storeConversationMessage({
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          sender: 'assistant',
          senderName: ASSISTANT_NAME,
          content: finalResult,
        });
      }

      updateConversationSession(
        conversationId,
        output.newSessionId,
        output.lastAssistantUuid,
      );
      setConversationStatus(conversationId, 'idle');

      const outboundMessages = consumeOutboundMessages(conversationId);
      const hasSessionEndMarker =
        containsSessionEndMarker(finalResult) ||
        outboundMessages.some((message) =>
          containsSessionEndMarker(message.text),
        );
      const durationMs = Date.now() - startedAt;
      const responseBody = {
        status: output.status,
        conversation_id: conversationId,
        message_id: assistantMessageId || userMessageId,
        result: finalResult,
        session_id: output.newSessionId || conversation.session_id,
        duration_ms: durationMs,
        error: output.error,
        outbound_messages: outboundMessages,
        session_end_marker: SESSION_END_MARKER,
        session_end_marker_detected: hasSessionEndMarker,
      };

      if (stream) {
        for (const outbound of outboundMessages) {
          writeSseEvent(res, 'chunk', {
            text: formatOutbound(outbound.text),
            sender: outbound.sender,
          });
        }
        writeSseEvent(res, 'done', responseBody);
        res.end();
        return;
      }

      res.json(responseBody);
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        const errorBody = {
          error: `Conversation ${conversationId} is currently processing another request`,
          conversation_id: conversationId,
        };
        if (stream) {
          writeSseEvent(res, 'error', errorBody);
          res.end();
          return;
        }
        res.status(409).json(errorBody);
        return;
      }

      setConversationStatus(conversationId, 'idle');
      const messageText = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, conversationId, requestId: req.requestId },
        'Chat request failed',
      );

      if (stream) {
        writeSseEvent(res, 'error', { error: messageText });
        res.end();
        return;
      }

      res.status(500).json({
        status: 'error',
        conversation_id: conversationId,
        message_id: userMessageId,
        result: null,
        error: messageText,
      });
    } finally {
      releaseLock?.();
    }
  });

  router.get('/', (_req: Request, res: Response) => {
    const conversations = getAllConversations();
    res.json({ conversations });
  });

  router.get('/:conversation_id/messages', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);
    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    const messages = getConversationMessages(conversationId);
    res.json({
      conversation_id: conversationId,
      messages,
    });
  });

  router.delete('/:conversation_id', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);
    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    if (conversation.status === 'running') {
      res.status(409).json({
        error: `Conversation ${conversationId} is currently running`,
        conversation_id: conversationId,
      });
      return;
    }

    deleteConversation(conversationId);
    res.status(204).send();
  });

  router.get('/:conversation_id', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);

    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    res.json({
      conversation_id: conversation.id,
      session_id: conversation.session_id,
      message_count: conversation.message_count,
      last_activity: conversation.last_activity,
      status: conversation.status,
    });
  });

  return router;
}
