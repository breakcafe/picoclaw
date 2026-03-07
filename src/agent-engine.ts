import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
  query,
} from '@anthropic-ai/claude-agent-sdk';

import {
  ASSISTANT_NAME,
  LOCAL_DB_PATH,
  MAX_EXECUTION_MS,
  MEMORY_DIR,
  SKILLS_DIR,
} from './config.js';

export interface AgentRunInput {
  prompt: string;
  conversationId: string;
  sessionId?: string;
  resumeAt?: string;
  timeoutMs?: number;
  assistantName?: string;
  isScheduledTask?: boolean;
}

export interface AgentRunOutput {
  status: 'success' | 'timeout' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  error?: string;
}

export interface AgentRunner {
  run(
    input: AgentRunInput,
    onChunk?: (text: string) => Promise<void> | void,
  ): Promise<AgentRunOutput>;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function resolveMcpServerPath(): string {
  const overridePath = process.env.NANOCLAW_MCP_SERVER_PATH;
  if (overridePath) {
    return overridePath;
  }

  return path.resolve(process.cwd(), 'dist/mcp-server.js');
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    ) as SessionsIndex;
    const entry = index.entries.find((item) => item.sessionId === sessionId);
    return entry?.summary || null;
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const now = new Date();
  return `conversation-${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          content?:
            | string
            | Array<{ type?: string; text?: string; [key: string]: unknown }>;
        };
      };

      if (entry.type === 'user' && entry.message?.content) {
        const userText =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((part) => part.text || '').join('');

        if (userText) {
          messages.push({ role: 'user', content: userText });
        }
      }

      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const assistantText = entry.message.content
          .filter((part) => part.type === 'text' && part.text)
          .map((part) => part.text as string)
          .join('');

        if (assistantText) {
          messages.push({ role: 'assistant', content: assistantText });
        }
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const sender =
      message.role === 'user' ? 'User' : assistantName || ASSISTANT_NAME;
    const text =
      message.content.length > 2_000
        ? `${message.content.slice(0, 2_000)}...`
        : message.content;
    lines.push(`**${sender}**: ${text}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const transcript = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(transcript);
      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = path.join(MEMORY_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const archivePath = path.join(conversationsDir, `${date}-${name}.md`);

      fs.writeFileSync(
        archivePath,
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
    } catch {
      // Archiving should never fail the main agent flow.
    }

    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const preToolUse = input as PreToolUseHookInput;
    const command = (preToolUse.tool_input as { command?: string }).command;

    if (!command) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preToolUse.tool_input as Record<string, unknown>),
          command: `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; ${command}`,
        },
      },
    };
  };
}

function discoverAdditionalDirectories(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  const discovered: string[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const fullPath = path.join(SKILLS_DIR, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      discovered.push(fullPath);
    }
  }
  return discovered;
}

function loadGlobalClaudeMd(): string | undefined {
  const globalPath = path.join(MEMORY_DIR, 'global', 'CLAUDE.md');
  if (!fs.existsSync(globalPath)) {
    return undefined;
  }

  return fs.readFileSync(globalPath, 'utf-8');
}

export class AgentEngine implements AgentRunner {
  async run(
    input: AgentRunInput,
    onChunk?: (text: string) => Promise<void> | void,
  ): Promise<AgentRunOutput> {
    const timeoutMs = input.timeoutMs ?? MAX_EXECUTION_MS;
    const abortController = new AbortController();

    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let lastResult: string | null = null;

    try {
      const sdkEnv: Record<string, string | undefined> = {
        ...process.env,
      };

      const globalClaudeMd = loadGlobalClaudeMd();
      const additionalDirectories = discoverAdditionalDirectories();
      const mcpServerPath = resolveMcpServerPath();

      if (!fs.existsSync(mcpServerPath)) {
        throw new Error(
          `MCP server not found at ${mcpServerPath}. Run npm run build first.`,
        );
      }

      const prompt = input.isScheduledTask
        ? `[SCHEDULED TASK]\n${input.prompt}`
        : input.prompt;

      for await (const message of query({
        prompt,
        options: {
          abortController,
          cwd: MEMORY_DIR,
          additionalDirectories:
            additionalDirectories.length > 0
              ? additionalDirectories
              : undefined,
          resume: input.sessionId,
          resumeSessionAt: input.resumeAt,
          systemPrompt: globalClaudeMd
            ? {
                type: 'preset',
                preset: 'claude_code',
                append: globalClaudeMd,
              }
            : undefined,
          allowedTools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'WebSearch',
            'WebFetch',
            'Task',
            'TaskOutput',
            'TaskStop',
            'TeamCreate',
            'TeamDelete',
            'SendMessage',
            'TodoWrite',
            'ToolSearch',
            'Skill',
            'NotebookEdit',
            'mcp__nanoclaw__*',
          ],
          env: sdkEnv,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'],
          mcpServers: {
            nanoclaw: {
              command: 'node',
              args: [mcpServerPath],
              env: {
                NANOCLAW_CONVERSATION_ID: input.conversationId,
                NANOCLAW_DB_PATH: LOCAL_DB_PATH,
                NANOCLAW_IS_MAIN: '1',
              },
            },
          },
          hooks: {
            PreCompact: [
              {
                hooks: [
                  createPreCompactHook(input.assistantName || ASSISTANT_NAME),
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [createSanitizeBashHook()],
              },
            ],
          },
        },
      }) as AsyncIterable<any>) {
        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
        }

        if (message.type === 'assistant' && message.uuid) {
          lastAssistantUuid = message.uuid;
        }

        if (message.type === 'result') {
          const text =
            typeof message.result === 'string' ? message.result : null;
          if (text) {
            lastResult = text;
            if (onChunk) {
              await onChunk(text);
            }
          }
        }
      }

      return {
        status: 'success',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        return {
          status: 'timeout',
          result: lastResult,
          newSessionId,
          lastAssistantUuid,
          error: `Execution aborted after ${timeoutMs}ms. Use conversation_id to continue.`,
        };
      }

      return {
        status: 'error',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
        error: errorMessage,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
