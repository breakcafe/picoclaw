# PicoClaw 技术评审与开发计划

> 面向团队的技术评审文档：场景验证、架构分析、与 NanoClaw 对比、发现的问题、以及后续开发计划。

## 1. 目标场景回顾

用户描述的核心场景：

1. **按需启动容器**：用户发起对话请求时，为其启动一个容器
2. **OSS 存储挂载**：容器挂载用户专属 OSS 目录 + 全局共用 OSS 目录（skills、默认人设等）
3. **单用户专属容器**：整个对话过程中容器为同一用户服务，支持运行多个 agent 和异步执行
4. **数据隔离**：OSS 专属目录实现数据隔离
5. **完整交互能力**：对话、本地文件访问、skills、MCP、OpenClaw 方式创建 skills
6. **记忆与持久化**：回答方式记录、长期记忆、对话归档
7. **会话结束标识**：回答结束后 API 返回明显标记
8. **跨会话复用**：对话/记忆/自建 skills 在 OSS 专属目录长期留存，下次启动可复用或新建
9. **无内置定时器**：不依赖 cronjob，定时触发依赖外部 API
10. **单用户 SQLite**：数据库只服务于一个用户

## 2. 场景满足度评估

### 2.1 已完整满足的场景

| 场景 | 实现方式 | 评估 |
|------|---------|------|
| **按需启动容器** | Docker 容器 + Express HTTP API，外部请求驱动 | **完全满足** |
| **OSS 专属目录挂载** | 4 个 volume mount：`/data/memory`、`/data/skills`、`/data/store`、`/data/sessions` | **完全满足** — 只需将 OSS 路径挂载到这 4 个位置 |
| **全局共用目录** | `/data/skills` (skills)、`/data/memory/global/CLAUDE.md` (默认人设) | **完全满足** — skills 目录可挂全局共用 OSS；global CLAUDE.md 作为人设 |
| **单用户专属容器** | 单进程 Express + Claude Agent SDK，同一容器全程服务 | **完全满足** |
| **多 agent 支持** | SDK 的 Agent Teams + Task/TeamCreate/SendMessage 工具 | **完全满足** — `allowedTools` 中包含 `Task`、`TeamCreate`、`TeamDelete`、`SendMessage` |
| **异步执行** | SDK 的 background task (`run_in_background: true`) + Task 工具 | **完全满足** |
| **对话能力** | `POST /chat` 端点，支持多轮对话和 SSE 流式输出 | **完全满足** |
| **本地文件访问** | Agent 的 `cwd` 设为 `MEMORY_DIR`，有完整文件工具 (Read/Write/Edit/Glob/Grep) | **完全满足** |
| **Skills 支持** | `/data/skills` → `.claude/skills/` 启动时同步；SKILL.md 格式 | **完全满足** |
| **MCP 支持** | MCP Server 作为 stdio 子进程，6 个内置工具 | **完全满足** |
| **记忆系统** | CLAUDE.md 人设 + `/data/memory/conversations/` 归档 + PreCompact Hook 自动保存 | **完全满足** |
| **API 结束标识** | `session_end_marker_detected` 字段 + 可配置的 `SESSION_END_MARKER` | **完全满足** |
| **跨会话复用** | `session_id` + `last_assistant_uuid` 存入 SQLite，volume 持久化 | **完全满足** |
| **无内置定时器** | 无 scheduler 循环；`POST /task/check` 由外部 cron 调用 | **完全满足** |
| **单用户 SQLite** | 单进程、单 DB 文件、无多租户逻辑 | **完全满足** |
| **数据隔离** | volume mount 边界 = 数据隔离边界 | **完全满足** |

### 2.2 需要注意或需补充的场景

| 场景 | 当前状态 | 状态 |
|------|---------|------|
| **OpenClaw 方式创建 skills** | 用户通过 agent 在 `/data/memory/skills/` 下创建 skill，调用 `POST /admin/reload-skills` 热重载 | **已解决** — 用户 skills 目录 + admin reload API |
| **回答方式记录** | agent 的回答存入 `messages` 表，但没有额外的"回答风格"元数据 | 如需结构化风格记录，可通过 CLAUDE.md 指令让 agent 自行维护 |
| **长期记忆** | PreCompact Hook 归档对话到 markdown；无独立的 memory extraction 机制 | 目前依赖 agent 自主在 CLAUDE.md 中写入记忆。如需更强的长期记忆，可考虑添加 memory extraction 后处理步骤 |
| **下次启动继承 memory** | CLAUDE.md 和 conversations/ 归档在 `/data/memory` volume 中，下次启动自动加载 | **满足**，但需确保用户的 OSS 挂载包含此路径 |
| **下次启动继承 skills** | `/data/skills` volume 在下次启动时重新同步到 `.claude/skills/` | **满足** |
| **新建对话继承 memory** | 新对话 `POST /chat` 不带 `conversation_id` 时创建新会话，但 CLAUDE.md 人设和 global memory 自动加载 | **满足** — SDK 的 `systemPrompt.append` 和 `settingSources: ['project', 'user']` 确保每次都加载 |

### 2.3 总结

> **picoclaw 的核心设计满足描述的所有场景，关键边界已在本轮评审中补齐。**
>
> 初始评审时，并发安全、API 完整性和 skills 生命周期存在缺口。经过本轮修复（对话锁、conversation/message 列表 API、skills 热重载、环境变量清理），这些缺口已闭合。相对 nanoclaw 的改动核心是移除了多 channel adapter 和 Docker-in-Docker 容器模型，替换为 HTTP API channel；agent 引擎、skills、memory、数据库、MCP 机制基本一致。

## 3. 架构对比：PicoClaw vs NanoClaw

### 3.1 整体架构差异

```
NanoClaw (多 Channel + 容器隔离):
  Channel Adapters (WhatsApp/Telegram/Slack/...)
    → SQLite (消息存储)
    → Polling Loop (2s)
    → GroupQueue (并发控制)
    → Docker Container (每 group 一个隔离容器)
      → Claude Agent SDK query()
      → IPC 文件通信 (输入/输出)
    → Router (格式化 + 回发到 channel)

PicoClaw (HTTP API + 单进程):
  HTTP Request
    → Express Router + Auth
    → SQLite (对话/消息存储)
    → AgentEngine.run()
      → Claude Agent SDK query() (同进程子进程)
      → MCP Server (stdio 子进程)
    → HTTP Response (JSON / SSE)
```

### 3.2 逐模块对比

| 模块 | NanoClaw | PicoClaw | 变化程度 |
|------|----------|----------|---------|
| **入口 (index.ts)** | 598 行，包含消息循环、触发检测、group 注册、container 调度 | 79 行，仅 boot + shutdown + 启动 Express | 大幅简化 |
| **Agent 引擎** | `container-runner.ts` (707 行) + `container/agent-runner/src/index.ts` (558 行) = 两层架构 | `agent-engine.ts` (480 行) = 单层直接调用 SDK | 从 Docker IPC 简化为同进程调用 |
| **消息输入** | Channel polling → IPC 文件 → MessageStream | HTTP POST → SQLite → XML 格式化 → MessageStream | 输入源变化，MessageStream 模式保持一致 |
| **消息输出** | stdout markers → container-runner 解析 → channel router | query() 结果 → HTTP JSON/SSE 响应 | 输出通道简化 |
| **数据库** | 7 表 (messages, chats, registered_groups, sessions, router_state, scheduled_tasks, task_run_logs) | 5 表 (conversations, messages, outbound_messages, scheduled_tasks, task_run_logs) | 精简——移除 chats/groups/sessions/router_state，新增 conversations/outbound_messages |
| **任务调度** | 内部 60s polling loop (`startSchedulerLoop`) | 外部 cron 调用 `POST /task/check` | 调度驱动方从内部改为外部 |
| **MCP 工具** | IPC 文件监控 (`ipc-mcp-stdio.ts`)，基于文件系统通信 | SQLite 直连 (`mcp-server.ts`)，基于共享数据库 | 通信方式简化 |
| **Skills** | container 内 `.claude/skills/` + 每 group 独立 session | 启动时 sync `/data/skills/` → `.claude/skills/` | 功能一致，同步时机不同 |
| **Memory** | 每 group 独立 CLAUDE.md (`/workspace/group/CLAUDE.md`) + global (`/workspace/global/CLAUDE.md`) | 单用户 CLAUDE.md (`/data/memory/CLAUDE.md`) + global (`/data/memory/global/CLAUDE.md`) | 从多 group 简化为单用户 |
| **Session 恢复** | session_id 存 DB → 下次传给 container | session_id + last_assistant_uuid 存 DB → 下次传给 SDK | 增加了 `resumeSessionAt` 精确恢复 |
| **安全模型** | Docker 容器隔离 + Credential Proxy | Bearer Token + Bash env 清洗 | 安全边界从 OS 隔离降为进程隔离 |
| **并发控制** | GroupQueue (max 5 concurrent) | 单请求串行（SQLite 限制） | 简化 |

### 3.3 代码复用度分析

以下组件从 NanoClaw 直接继承或小幅修改：

| 组件 | 复用度 | 修改说明 |
|------|--------|---------|
| `MessageStream` | ~95% | 仅移除了 IPC polling 逻辑 |
| `PreCompactHook` | ~90% | 归档路径从 `/workspace/group/conversations` 改为 `/data/memory/conversations` |
| `parseTranscript` / `formatTranscriptMarkdown` | ~95% | 几乎一致 |
| `skills-engine/` | 100% | 完整继承 |
| 任务调度逻辑 | ~80% | 移除内部 loop，保留计算逻辑 |
| MCP 工具定义 | ~70% | 从 IPC 文件改为 SQLite 直连 |

## 4. 代码质量与实现评估

### 4.1 构建与测试

- **TypeScript 编译**：`npm run build` 零错误通过
- **单元测试**：6 个测试文件、28 个测试用例全部通过（Phase 1: 23 个 + Phase 2: 5 个新增）
- **E2E 测试**：`scripts/e2e-test.sh` 全部通过（含真实 Claude API 多轮对话、重启持久化、session resume、动态 skill 创建与重载）
- **代码格式**：Prettier + Husky pre-commit hook，全部文件合规

### 4.2 架构优点

1. **极简设计**：src/ 目录仅 ~12 个核心文件（不含 test），总代码量约 2,000 行
2. **清晰的分层**：`server.ts` → `routes/` → `agent-engine.ts` → `db.ts`，职责单一
3. **Dual-DB 策略**：`/tmp` 本地 + `/data/store` 持久化，既保 SQLite 性能又保数据安全
4. **SDK 集成成熟**：MessageStream、Hook 系统、session resume 都经过深入理解和正确实现
5. **文档完备**：DESIGN_RATIONALE、SDK_DEEP_DIVE、SECURITY 等文档超过 100KB，覆盖架构决策和 SDK 内部原理
6. **可测试性**：`AgentRunner` 接口抽象允许测试中注入 mock engine
7. **优雅关停**：SIGTERM/SIGINT/API 三路径均触发 sync-close-exit 序列

### 4.3 发现的问题与风险

> 注：以下问题在初始评审中发现，标注了当前修复状态。GPT 评审团队（见 `Improvement-GPT.md`）独立发现了其中多项，验证了这些问题的真实性。

#### P0 - 严重问题（已全部修复）

| # | 问题 | 修复方案 | 状态 |
|---|------|---------|------|
| 1 | **并发请求可能导致 SQLite 损坏** | 新增 `src/conversation-lock.ts`：per-conversation 互斥锁。集成到 `POST /chat`、`POST /task/trigger`、`POST /task/check`。同一对话并发请求返回 `409 Conflict`，不同对话可并发执行 | **已修复** |
| 2 | **Conversation status 不阻塞并发** | `acquireConversationLock(id, { wait: false })` 在路由层实际阻止并发执行，不再仅依赖 status 标记 | **已修复** |

#### P1 - 重要问题（7/7 已全部修复）

| # | 问题 | 修复方案 | 状态 |
|---|------|---------|------|
| 3 | **Skills 无 hot-reload** | 新增 `POST /admin/reload-skills` 端点 + `GET /admin/skills`，重新同步 shared + user skills 到 `.claude/skills/` | **已修复** |
| 4 | **无 conversation 列表 API** | 新增 `GET /chat` 端点，返回所有对话列表（按 `last_activity` 降序） | **已修复** |
| 5 | **无消息历史 API** | 新增 `GET /chat/:id/messages` 端点，返回对话完整消息历史 | **已修复** |
| 6 | **outbound_messages 未自动清理** | `cleanupStaleData()` 在 `syncDatabaseToVolume()` 前执行，删除已投递的过期消息（`OUTBOUND_TTL_DAYS`，默认 7 天） | **已修复** (Phase 2) |
| 7 | **task_run_logs 未限制** | `cleanupStaleData()` 每个 task 保留最近 N 条日志（`TASK_LOG_RETENTION`，默认 100 条） | **已修复** (Phase 2) |

#### P2 - 优化建议（2/4 已修复）

| # | 问题 | 修复方案 | 状态 |
|---|------|---------|------|
| 8 | **命名遗留** | MCP 环境变量从 `NANOCLAW_*` 重命名为 `PICOCLAW_*`，保留向后兼容 fallback | **已修复** |
| 9 | **API_TOKEN 泄露风险** | `API_TOKEN` 加入 `SECRET_ENV_VARS`，PreToolUse hook 从 Bash 环境中清除 | **已修复** |
| 10 | **SSE 流式输出粒度** | 当前只在 `result` 消息到达时发送 chunk，而非逐 token 流式 | 待优化 — 需启用 SDK `includePartialMessages` |
| 11 | **无请求 ID / 追踪** | HTTP 请求没有生成 request-id 用于日志追踪 | 待优化 |
| 12 | **健康检查不含深度信息** | `/health` 不检查 SQLite 连通性或 disk 可用空间 | 待优化 |

## 5. OSS 挂载方案设计

根据描述的场景，OSS 目录映射到 picoclaw 的 volume：

```
OSS 用户专属目录/
├── memory/         → 挂载到 /data/memory    (用户人设、全局记忆、对话归档)
│   ├── CLAUDE.md                             (用户专属人设)
│   ├── global/
│   │   └── CLAUDE.md                         (全局共享上下文)
│   └── conversations/                        (自动归档的对话记录)
├── store/          → 挂载到 /data/store     (SQLite 数据库持久化)
│   └── messages.db
└── sessions/       → 挂载到 /data/sessions  (Claude SDK session 状态)
    └── .claude/
        ├── sessions/
        └── settings.json

OSS 全局共用目录/
├── skills/         → 挂载到 /data/skills    (全局 skills 定义)
│   ├── add-pdf-reader/
│   ├── add-image-vision/
│   └── ...
└── default-persona/ → 首次启动时复制到 /data/memory/CLAUDE.md
```

### 挂载配置示例（Docker）

```bash
docker run --rm -it \
  -p 9000:9000 \
  -v /oss/users/{user_id}/memory:/data/memory \
  -v /oss/users/{user_id}/store:/data/store \
  -v /oss/users/{user_id}/sessions:/data/sessions \
  -v /oss/global/skills:/data/skills \
  -e API_TOKEN=${generated_token} \
  -e ANTHROPIC_BASE_URL=${api_base} \
  -e ANTHROPIC_API_KEY=${api_key} \
  picoclaw:latest
```

### 用户自建 Skills 处理

用户通过 agent 创建的 skills 应保存在**用户专属目录**中。建议方案：

```
/data/memory/skills/    ← 用户自建 skills (agent 的 cwd 在 /data/memory 下可写)
/data/skills/           ← 全局共用 skills (read-only 挂载)
```

启动时两个目录都同步到 `.claude/skills/`，用户目录优先级高于全局目录（允许覆盖）。

## 6. 与 NanoClaw 的关键代码迁移点

### 6.1 已正确迁移的部分

| 部分 | nanoclaw 位置 | picoclaw 位置 | 状态 |
|------|-------------|--------------|------|
| MessageStream | `container/agent-runner/src/index.ts:65-95` | `src/agent-engine.ts:67-109` | 已正确迁移，移除了 IPC polling |
| PreCompactHook | `container/agent-runner/src/index.ts:145-185` | `src/agent-engine.ts:239-274` | 已正确迁移，路径适配 |
| parseTranscript | `container/agent-runner/src/index.ts:205-229` | `src/agent-engine.ts:165-210` | 已正确迁移 |
| SDK query() 调用 | `container/agent-runner/src/index.ts:392-460` | `src/agent-engine.ts:359-448` | 已正确迁移，参数适配 |
| 任务计算逻辑 | `src/task-scheduler.ts` | `src/task-scheduler.ts` | 已正确迁移 |
| MCP 工具 | `container/agent-runner/src/ipc-mcp-stdio.ts` | `src/mcp-server.ts` | 从 IPC 文件改为 SQLite 直连 |

### 6.2 NanoClaw 有但 PicoClaw 未迁移的功能

| 功能 | nanoclaw 位置 | 是否需要迁移 | 说明 |
|------|-------------|-------------|------|
| IPC follow-up 消息 | `agent-runner:waitForIpcMessage()` | **不需要** | picoclaw 通过 HTTP 多轮对话替代 |
| Container idle timeout | `container-runner.ts:IDLE_TIMEOUT` | **不需要** | picoclaw 由外部控制容器生命周期 |
| Group 管理 (注册/触发) | `index.ts:registerGroup()` | **不需要** | picoclaw 是单用户，无 group 概念 |
| Channel adapter 系统 | `channels/` | **不需要** | picoclaw 的 channel 就是 HTTP API |
| Credential Proxy | `credential-proxy.ts` | **不需要** | picoclaw 环境变量直接注入 + Bash hook 清洗 |
| Mount Security | `mount-security.ts` | **不需要** | picoclaw 通过 volume mount 控制 |
| Sender Allowlist | `sender-allowlist.ts` | **不需要** | picoclaw 通过 Bearer Token 认证 |
| GroupQueue 并发控制 | `group-queue.ts` | **建议迁移思路** | picoclaw 需要 request-level mutex（见 P0 问题） |
| `resumeSessionAt` 在 nanoclaw | `agent-runner:queryResult.lastAssistantUuid` | **已迁移** | picoclaw 已实现此机制 |

### 6.3 PicoClaw 新增的功能

| 功能 | 位置 | 说明 |
|------|------|------|
| HTTP API (Express) | `src/server.ts` + `src/routes/` | 全新的 HTTP channel |
| Bearer Token 认证 | `src/middleware/auth.ts` | 替代 channel 认证 |
| SSE 流式响应 | `src/routes/chat.ts:42-45,110-118` | 实时输出 |
| Dual-DB Sync | `src/db.ts:164-169` | `/tmp` → volume 同步策略 |
| Outbound Messages | `outbound_messages` 表 + MCP `send_message` | 替代 IPC 输出通道 |
| Session End Marker | `SESSION_END_MARKER` + `session_end_marker_detected` | 会话结束信号 |
| Graceful Stop API | `POST /control/stop` | 编程式关停 |
| Lambda Adapter | Dockerfile `ENABLE_LAMBDA_ADAPTER` | Serverless 部署适配 |

## 7. 安全性评估

### 7.1 当前安全边界

```
外部网络 → [API Gateway/WAF] → Bearer Token → Express Router → Agent (Sandbox)
                                                                    ↓
                                                             Container 边界
```

### 7.2 安全评级

| 方面 | 评级 | 说明 |
|------|------|------|
| 认证 | 良好 | Bearer Token，无 token 时 /health 仅暴露版本号 |
| 密钥隔离 | 良好 | PreToolUse Hook 清洗 Bash 环境中的 API key |
| 文件隔离 | 一般 | agent 可访问容器内所有文件（设计如此），但 volume 边界限制了范围 |
| 数据库安全 | 一般 | 无加密，依赖 volume 权限控制 |
| 注入防护 | 良好 | Zod schema 验证 MCP 输入，XML 转义输出 |
| 日志安全 | 良好 | pino 结构化日志，不记录完整请求体 |

### 7.3 安全建议

1. **API Gateway 层必须添加 rate limiting**——picoclaw 本身无此能力
2. **API_TOKEN 应足够长且随机**——建议 256-bit 随机 token
3. **生产环境开启 TLS**——通过 API Gateway 或反向代理
4. **定期轮换 API_TOKEN 和 ANTHROPIC_API_KEY**

## 8. 本轮修复变更清单

> 以下为本轮评审中完成的所有代码变更，按优先级排列。

### 8.1 P0：Per-conversation 并发锁（最关键修复）

**新增文件**：
- `src/conversation-lock.ts` — 核心锁实现，per-conversation 互斥，支持 queue 模式和 reject 模式
- `src/conversation-lock.test.ts` — 4 个测试用例覆盖：顺序访问、不同对话并发、ConversationBusyError、队列等待

**修改文件**：
- `src/routes/chat.ts` — `POST /chat` 请求前 `acquireConversationLock(id, { wait: false })`，catch `ConversationBusyError` 返回 409
- `src/routes/task.ts` — `POST /task/trigger` 和 `POST /task/check` 对 group 模式任务加锁；busy 时 trigger 返回 409，check 返回 `status: 'skipped'`
- `src/server.test.ts` — 新增并发 409 测试：用 slow engine 验证同一对话的两个并发请求，一个 200 一个 409

**设计要点**：
- 不同对话之间可完全并发——锁粒度是 conversation，不是全局
- Chat 路由使用 `wait: false`（立即拒绝），避免 HTTP 请求长时间挂起
- `finally { releaseLock?.() }` 确保异常路径也释放锁

### 8.2 安全修复：API_TOKEN 环境变量清洗

**修改文件**：`src/agent-engine.ts`

**变更**：将 `API_TOKEN` 加入 `SECRET_ENV_VARS` 数组。PreToolUse hook 在每次 Bash 命令执行前 `unset API_TOKEN`，防止 agent 通过 `echo $API_TOKEN` 读取 HTTP 认证令牌。

### 8.3 API 完善：对话列表和消息历史

**修改文件**：
- `src/db.ts` — 新增 `getAllConversations()` 函数，按 `last_activity DESC` 排序
- `src/routes/chat.ts` — 新增 `GET /chat`（列出所有对话）和 `GET /chat/:id/messages`（获取消息历史）
- `src/server.test.ts` — 新增 2 个测试用例

### 8.4 Skills 热重载和用户 Skills 目录

**新增文件**：`src/routes/admin.ts`

**修改文件**：
- `src/skills.ts` — 重写为 overlay 模型：shared skills (`SKILLS_DIR`) + user skills (`USER_SKILLS_DIR`，默认 `/data/memory/skills`)，用户 skills 优先级高于全局
- `src/server.ts` — 挂载 `app.use('/admin', adminRoutes())`

**新环境变量**：`USER_SKILLS_DIR`（默认 `/data/memory/skills`）

### 8.5 环境变量命名清理

**修改文件**：`src/agent-engine.ts`、`src/mcp-server.ts`

MCP server env vars 从 `NANOCLAW_*` 改为 `PICOCLAW_*`，保留向后兼容 fallback。

### 8.6 测试覆盖增量（Phase 1）

| 测试文件 | 新增测试 | 当前测试数 |
|---------|---------|-----------|
| `conversation-lock.test.ts` | 4 个（新建文件） | 4 |
| `server.test.ts` | 3 个：对话列表、消息历史、409 并发 | 8 |
| 其余文件 | 无变更 | 11 |
| **合计** | **7 个新增** | **23** |

### 8.7 测试覆盖增量（Phase 2）

| 测试文件 | 新增测试 | 当前测试数 |
|---------|---------|-----------|
| `db.test.ts` | 3 个：outbound 清理、task_run_logs 保留、对话删除 | 6 |
| `server.test.ts` | 2 个：DELETE 对话 204、DELETE 对话 404 | 10 |
| 其余文件 | 无变更 | 12 |
| **合计** | **5 个新增** | **28** |

## 9. 与 GPT 评审团队意见的对照

> 参考：`Improvement-GPT.md`

| GPT 团队指出的问题 | 我方初始评估 | 最终判断 | 处理结果 |
|-------------------|-------------|---------|---------|
| 并发安全缺失 | 已识别为 P0 | 完全同意 | 已修复 — conversation-lock.ts |
| API_TOKEN 可被 agent 读取 | 初始遗漏 | GPT 正确 | 已修复 — 加入 SECRET_ENV_VARS |
| 缺少 conversation 列表/历史 API | 已识别为 P1 | 完全同意 | 已修复 — GET /chat + GET /chat/:id/messages |
| Skills 无法热重载 | 已识别为 P1 | 完全同意 | 已修复 — POST /admin/reload-skills |
| NANOCLAW_ 命名混淆 | 已识别为 P2 | 完全同意 | 已修复 — 重命名为 PICOCLAW_* |
| 私有/共享目录抽象不足 | 初始评为"完全满足" | GPT 正确 | 已修复 — USER_SKILLS_DIR overlay 模型 |
| 数据清理策略缺失 | 已识别为 P1 | 同意但优先级可降 | 留待后续 Phase |

**总结**：GPT 评审团队的意见总体准确，特别是在 API_TOKEN 泄露和私有/共享目录抽象这两个我方初始遗漏的点上提供了有价值的补充。

## 10. 开发计划（修订版）

> Phase 1 已在本轮完成。以下为后续计划。

### Phase 1：稳固基础 — 已完成

- [x] Per-conversation 并发锁 (`conversation-lock.ts`)
- [x] 409 Conflict 检测和返回
- [x] API_TOKEN 环境变量清洗
- [x] NANOCLAW_* 重命名为 PICOCLAW_*
- [x] GET /chat 对话列表
- [x] GET /chat/:id/messages 消息历史
- [x] Skills 热重载 + 用户 Skills overlay
- [x] 单元测试覆盖（23/23 pass）
- [x] E2E 测试验证（26/26 pass）

### Phase 2：数据生命周期、内置 Skills、文档对齐 — 已完成

- [x] Outbound Messages TTL 自动清理（`OUTBOUND_TTL_DAYS`，默认 7 天，`cleanupStaleData()` → `syncDatabaseToVolume()`）
- [x] Task Run Logs 保留策略（`TASK_LOG_RETENTION`，默认每个 task 保留最近 100 条）
- [x] Conversation 删除 API（`DELETE /chat/:conversation_id`，204/404/409）
- [x] agent-browser 作为内置 skill 打包到 Docker 镜像（`/app/built-in-skills/`）
- [x] 三级 skill 优先级：built-in → shared → user
- [x] 简化 memory 目录结构（移除 prescriptive subdirs，agent 按需创建）
- [x] 文档中 `NANOCLAW_*` 引用全部更新为 `PICOCLAW_*`（含 fallback 说明）
- [x] OpenAPI 规范补全：GET /chat、GET /chat/:id/messages、DELETE /chat/:id、admin 端点、409 响应
- [x] E2E 测试新增动态 skill 创建与重载测试
- [x] 单元测试 28/28 全部通过

### Phase 3：可观测性增强 (低优先级)

- 增强 Health Check（database 连通性、目录可用性、skills 数量）
- Usage 统计（从 SDK result 提取 `total_cost_usd`、`num_turns`）
- SSE 逐 token 流式（启用 SDK `includePartialMessages`）
- Request-ID 中间件

### Phase 4：部署与运维 (按需)

- Alibaba Cloud FC 适配（NAS 挂载、Timer Trigger）
- Kubernetes 编排（Deployment + PV/PVC）
- CI/CD 流水线（GitHub Actions: build → test → Docker push）

## 11. 测试策略

### 11.1 当前测试覆盖

| 测试文件 | 覆盖范围 | 测试数 |
|---------|---------|--------|
| `server.test.ts` | HTTP 端点、认证、多轮对话、任务 CRUD、关停、对话列表、消息历史、409 并发、DELETE 对话 | 10 |
| `conversation-lock.test.ts` | 顺序访问、并发不同对话、ConversationBusyError、队列等待 | 4 |
| `db.test.ts` | 数据库 CRUD、outbound 清理、task_run_logs 保留、对话删除 | 6 |
| `router.test.ts` | XML 格式化 | 2 |
| `task-scheduler.test.ts` | Cron/interval/once 调度计算 | 4 |
| `openapi.test.ts` | OpenAPI 规范验证 | 2 |

### 11.2 建议补充的测试

| 测试场景 | 优先级 | 说明 |
|---------|--------|------|
| MCP Server 工具单元测试 | 高 | 当前无 mcp-server.ts 测试 |
| SSE 流式响应 | 中 | 验证事件顺序和格式 |
| Database sync 可靠性 | 中 | 验证 shutdown 场景下的数据完整性 |
| Auth middleware 边界 | 低 | 空 token、超长 token 等 |
| Task 调度准确性 | 低 | 验证 cron 时区处理 |

## 12. 总结

### 12.1 核心结论

1. **PicoClaw 满足描述的所有核心使用场景，关键边界已补齐**。它是一个设计精良的单用户容器化 Agent 运行时，通过 HTTP API 暴露完整的对话和任务管理能力。初始评审中发现的并发安全、API 完整性和 skills 生命周期问题已全部修复。

2. **相对 NanoClaw 的改动确实不大**——保留了 Agent SDK 集成的核心（MessageStream、Hooks、Session Resume），移除了多 channel 和 Docker-in-Docker，添加了 HTTP API 层。代码量从 NanoClaw 的 ~3,000 行核心代码减少到 ~2,000 行（不含新增的 ~270 行修复代码）。

3. **SQLite 数据库是给单用户服务的**——无多租户逻辑，全部数据在一个 DB 文件中，通过 volume mount 实现用户级数据隔离。

4. **并发安全已修复**——per-conversation 互斥锁已集成到所有 agent 执行路径，同一对话的并发请求返回 409 Conflict。

5. **GPT 评审团队的意见提供了有价值的补充**——特别是 API_TOKEN 泄露和私有/共享目录抽象两个初始遗漏点。

### 12.2 推荐的后续步骤

1. **配置** OSS 挂载方案并进行端到端联调
2. **实现** Phase 2 的数据生命周期管理
3. **部署** 到目标云平台并验证
4. **补充** MCP Server 单元测试（当前测试盲区）

---

*文档版本: 3.0*
*评审日期: 2026-03-10*
*更新日期: 2026-03-10*
*基于 picoclaw v1.2.14, nanoclaw latest (commit on disk)*
*变更：Phase 1 + Phase 2 全部完成。Phase 2 新增数据生命周期管理、内置 skills 三级优先级、memory 简化、OpenAPI 补全、E2E 动态 skill 测试。28 个单元测试全部通过。*
