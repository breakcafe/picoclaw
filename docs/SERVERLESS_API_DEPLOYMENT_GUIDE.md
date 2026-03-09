# PicoClaw Serverless API 与部署手册

> 适用版本：`feat/serverless-lambda-lite` 分支
> 目标读者：运维团队、平台团队、下游调用方

## 1. 文档目标

本文档用于说明改造后的 PicoClaw 在以下方面的落地细节：

- API 调用方式（含鉴权、SSE、多轮对话、任务调度）
- 容器化部署方式（本地、AWS Lambda、阿里云 FC）
- 运行架构与持久化设计
- 运维注意事项、常见故障排查、上线检查项

## 1.1 交付产物

本仓库同时提供可直接导入的 API 产物：

- `openapi.yaml`（OpenAPI 3.0.3 源文件）
- `openapi.json`（OpenAPI JSON 导出版）
- `postman_collection.json`（Postman Collection）

推荐流程：

1. 先阅读本文档了解运行与运维约束。  
2. 下游系统直接导入 `openapi.yaml` 或 `openapi.json`。  
3. 联调阶段使用 `postman_collection.json` 快速验证。  

## 2. 架构概览

### 2.1 运行模式变化

当前版本采用 **单容器 + HTTP 请求驱动**：

- 进程不做消息轮询，不做内建长期调度循环。
- 每次请求触发一次处理（chat/task）。
- Claude Agent SDK 作为核心执行引擎保留。
- MCP Server 仍是 SDK 管理的 stdio 子进程，但不再依赖 IPC 文件。

### 2.2 逻辑拓扑

```text
HTTP Client / API Gateway / Cron Trigger
                |
                v
        PicoClaw (Node.js)
        - Express HTTP API
        - AgentEngine (Claude Agent SDK query)
        - SQLite (/tmp/messages.db)
        - DB sync to /data/store/messages.db
                |
                +--> MCP Server (stdio child process)
                      - 直接读写同一 SQLite
```

### 2.3 数据与外挂卷

默认目录（可由环境变量覆盖）：

- `MEMORY_DIR=/data/memory`
- `SKILLS_DIR=/data/skills`
- `SESSIONS_DIR=/data/sessions`
- `STORE_DIR=/data/store`
- 本地执行数据库：`LOCAL_DB_PATH=/tmp/messages.db`

推荐挂载：

```text
/data/memory    # CLAUDE.md、对话归档、工作目录
/data/skills    # SKILL.md 技能目录
/data/sessions  # .claude 会话数据
/data/store     # 持久化 SQLite
```

关键提醒（避免误区）：

- 在 Serverless 模式下，`memory` 与 `conversation history` 依然是核心能力。
- 业务侧“同一用户的间隔请求”需要复用历史上下文时，必须保证上述目录持久化（如 OSS/NAS/EFS 挂载）持续可用。

## 3. 生命周期与状态

### 3.1 对话状态

对话状态在 SQLite `conversations` 表维护：

- `session_id`：Claude 会话 ID
- `last_assistant_uuid`：用于 resumeSessionAt
- `status`：`idle` / `running`

行为规则：

- `POST /chat` 不带 `conversation_id`：创建新会话。
- `POST /chat` 带 `conversation_id`：续接会话；若不存在返回 `404`。

### 3.2 任务状态

任务在 `scheduled_tasks` 表维护：

- `schedule_type`：`cron` / `interval` / `once`
- `context_mode`：`group` / `isolated`
- `status`：`active` / `paused` / `completed`

关键规则：

- `POST /task/check` 每次只执行 **1 个**到期任务。
- `once` 任务执行后 `next_run = null`，状态转为 `completed`。

### 3.3 数据同步

数据库策略：

- 运行中操作 `/tmp/messages.db`（高性能本地路径）。
- 每次请求结束时自动 `wal_checkpoint + copy` 到 `/data/store/messages.db`。
- 收到 `SIGTERM/SIGINT` 时再次同步并关闭 DB。

### 3.4 版本对齐原则

- Claude Agent SDK 与 MCP SDK 版本以原版 NanoClaw 的稳定基线为准。
- 当前实现对齐：
  - `@anthropic-ai/claude-agent-sdk`: `0.2.34`
  - `@modelcontextprotocol/sdk`: `1.12.1`
- 后续升级应做兼容回归，不建议“为了裁剪而降级”。

## 4. 环境变量

### 4.1 必需项

- `API_TOKEN`：API Bearer Token
- `ANTHROPIC_API_KEY` 或 Claude Code 认证环境变量

### 4.2 常用可选项

- `ANTHROPIC_BASE_URL`：兼容第三方代理网关
- `PORT`：默认 `9000`
- `MAX_EXECUTION_MS`：默认 `300000`（5 分钟）
- `ASSISTANT_NAME`：默认 `Pico`
- `TZ`：时区（影响 cron 解析）
- `LOG_LEVEL`：日志级别
- `STORE_DIR` / `MEMORY_DIR` / `SKILLS_DIR` / `SESSIONS_DIR` / `LOCAL_DB_PATH`
- `NANOCLAW_MCP_SERVER_PATH`：自定义 MCP server 可执行路径

## 5. 鉴权

除 `/health` 外，全部 API 需要：

```http
Authorization: Bearer <API_TOKEN>
```

错误码：

- `401 Unauthorized`：token 缺失或错误
- `500`：服务端未配置 `API_TOKEN`

## 6. API 详细说明

Base URL 示例：`http://localhost:9000`

### 6.1 健康检查

`GET /health`

响应示例：

```json
{
  "status": "ok",
  "version": "1.0.0",
  "max_execution_ms": 300000
}
```

### 6.2 发起/续接对话

`POST /chat`

请求体：

```json
{
  "message": "请只回答数字：1+1 等于几？",
  "conversation_id": "conv-xxx",
  "sender": "user-1",
  "sender_name": "Alice",
  "stream": false,
  "max_execution_ms": 120000
}
```

字段说明：

- `message`：必填
- `conversation_id`：可选，不传则新建
- `stream=true`：SSE 流式返回
- `max_execution_ms`：请求级超时，实际上限为环境变量 `MAX_EXECUTION_MS`

非流式响应：

```json
{
  "status": "success",
  "conversation_id": "conv-0df6...",
  "message_id": "msg-3aaf...",
  "result": "2",
  "session_id": "3e49...",
  "duration_ms": 6701,
  "outbound_messages": [],
  "session_end_marker": "[[PICOCLAW_SESSION_END]]",
  "session_end_marker_detected": false
}
```

`status` 可能值：

- `success`
- `timeout`
- `error`

会话结束相关字段：

- `session_end_marker`：当前运行时约定的会话结束标记字符串。
- `session_end_marker_detected`：若结果中检测到结束标记，该值为 `true`。

### 6.3 SSE 流式对话

当 `stream=true` 时，响应头为 `text/event-stream`，事件类型：

- `start`：开始（含 `conversation_id`）
- `chunk`：增量文本
- `done`：最终结果（完整结果结构）
- `error`：处理失败

示例：

```text
event: start
data: {"conversation_id":"conv-...","message_id":"msg-..."}

event: chunk
data: {"text":"部分输出"}

event: done
data: {"status":"success","conversation_id":"conv-...","session_end_marker":"[[PICOCLAW_SESSION_END]]","session_end_marker_detected":true}
```

### 6.4 查询会话状态

`GET /chat/:conversation_id`

响应示例：

```json
{
  "conversation_id": "conv-0df6...",
  "session_id": "3e49...",
  "message_count": 4,
  "last_activity": "2026-03-08T01:57:18.082Z",
  "status": "idle"
}
```

### 6.5 创建任务

`POST /task`

请求示例：

```json
{
  "id": "daily-report",
  "prompt": "请输出今天日报",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "context_mode": "isolated",
  "conversation_id": "conv-xxx"
}
```

注意：

- `schedule_type=once` 时，`schedule_value` 必须为**本地时间字符串**，不要带 `Z` 或时区偏移。
- 未提供 `conversation_id` 会自动创建一个。

### 6.6 任务列表

`GET /tasks`

响应：

```json
{
  "tasks": [
    {
      "id": "daily-report",
      "conversation_id": "conv-xxx",
      "prompt": "...",
      "schedule_type": "cron",
      "schedule_value": "0 9 * * 1-5",
      "context_mode": "isolated",
      "next_run": "2026-03-09T01:00:00.000Z",
      "last_run": null,
      "last_result": null,
      "status": "active",
      "created_at": "2026-03-08T02:00:00.000Z"
    }
  ]
}
```

### 6.7 更新任务

`PUT /task/:task_id`

支持局部更新：

- `prompt`
- `schedule_type`
- `schedule_value`
- `context_mode`
- `status`
- `conversation_id`

如更新 `schedule_type` 或 `schedule_value`，系统会重新计算 `next_run`。

### 6.8 删除任务

`DELETE /task/:task_id`

成功返回 `204 No Content`。

### 6.9 手动触发指定任务

`POST /task/trigger`

请求体：

```json
{
  "task_id": "daily-report"
}
```

响应示例：

```json
{
  "status": "success",
  "task_id": "daily-report",
  "result": "ok",
  "duration_ms": 4874,
  "next_run": null
}
```

### 6.10 检查并执行到期任务

`POST /task/check`

无到期任务：

```json
{
  "checked": 0,
  "message": "No due tasks"
}
```

有到期任务：

```json
{
  "checked": 3,
  "executed": {
    "status": "success",
    "task_id": "task-1",
    "result": "...",
    "duration_ms": 3500,
    "next_run": "2026-03-08T02:10:00.000Z"
  },
  "remaining": 2
}
```

### 6.11 主动停止运行时

`POST /control/stop`

请求体（可选）：

```json
{
  "reason": "end-of-session"
}
```

响应示例：

```json
{
  "status": "stopping",
  "reason": "end-of-session",
  "message": "Shutdown accepted. The runtime will sync data and exit gracefully."
}
```

典型流程：

1. 调用 `/chat` 并检查 `session_end_marker_detected`。
2. 若为 `true`，调用 `/control/stop` 请求主进程保存并退出。
3. 若不走 API，也可直接由外部 Serverless 发送 `SIGTERM`，服务同样会执行保存并退出。

## 7. 部署指南

### 7.0 一键启动与冒烟测试

仓库根目录提供脚本 `picoclaw.sh`，用于填入 Key 后一键完成：

- 生成/更新 `.env`
- 构建 TypeScript
- 构建 Docker 镜像
- 启动容器
- 执行健康检查与 `/chat` 冒烟测试

```bash
./picoclaw.sh
```

常用子命令：

```bash
./picoclaw.sh up
./picoclaw.sh test
./picoclaw.sh stop-api
./picoclaw.sh logs
./picoclaw.sh down
```

### 7.1 本地 Node 运行

```bash
npm ci
npm run build
API_TOKEN=dev-token ANTHROPIC_API_KEY=xxx npm start
```

### 7.2 本地 Docker 运行

构建：

```bash
docker build --platform linux/amd64 -t picoclaw:latest .
```

运行：

```bash
docker run --rm -it \
  -p 9000:9000 \
  -e API_TOKEN=dev-token \
  -e ANTHROPIC_API_KEY=xxx \
  -v $(pwd)/dev-data/memory:/data/memory \
  -v $(pwd)/dev-data/skills:/data/skills \
  -v $(pwd)/dev-data/store:/data/store \
  -v $(pwd)/dev-data/sessions:/data/sessions \
  picoclaw:latest
```

也可直接使用：

```bash
make docker-build
make docker-run
```

### 7.3 AWS Lambda（容器镜像）

建议配置：

- Runtime: Container Image
- Memory: 4096MB 起
- Timeout: `MAX_EXECUTION_MS + 30s`（例如 330s）
- 挂载 EFS 到 `/data`

构建 Lambda 适配镜像：

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```

### 7.4 阿里云 FC（自定义容器）

建议配置：

- Runtime: custom-container
- 监听端口：`9000`
- NAS 挂载到 `/data`
- Timeout 同样建议大于 `MAX_EXECUTION_MS`

## 8. 运维注意事项

### 8.1 安全

- `API_TOKEN` 与模型凭据必须由密钥系统注入，不要写入镜像层。
- 建议将服务放在私有网络后，由 API Gateway/WAF 提供边界防护。
- 建议启用调用方级别的访问审计与限流。

### 8.2 并发与一致性

- 单实例内数据库为 SQLite，本地路径 `/tmp/messages.db`。
- 多实例并发由云平台管理，建议按场景控制实例并发。
- 若要求强一致队列语义，应在网关层做幂等与重试设计。

### 8.3 定时任务

- 系统内不做常驻调度，必须由外部 Cron（EventBridge/FC 定时触发器）调用 `/task/check`。
- 由于一次只执行一个到期任务，建议高频触发（例如每 1 分钟）。

### 8.4 停止策略

- API 停止：`POST /control/stop`（推荐在检测到会话结束标记后调用）。
- 信号停止：由 Serverless 平台发送 `SIGTERM`，服务会在 signal handler 中持久化并退出。
- 建议调用方保持幂等：`/control/stop` 可能与平台回收信号接近同时发生。

### 8.5 备份恢复

建议备份目录：

- `/data/store/messages.db`
- `/data/sessions/.claude`
- `/data/memory`

恢复时确保版本兼容并优先恢复 `store + sessions`。

### 8.6 日志

服务默认使用 `pino` 输出。

建议在平台侧采集：

- 请求耗时、状态码、错误率
- `status=timeout` 比例
- `task/check remaining` 长期积压情况

## 9. 常见故障排查

### 9.1 `401 Unauthorized`

检查：

- 请求头是否带 `Authorization: Bearer <token>`
- 服务端 `API_TOKEN` 与调用 token 是否一致

### 9.2 `/chat` 返回 `conversation_id not found`

原因：

- 传入了不存在的 `conversation_id`

处理：

- 不传 `conversation_id` 重新创建，或使用已存在 ID

### 9.3 `MCP server not found ... dist/mcp-server.js`

原因：

- 未执行构建或构建产物缺失

处理：

```bash
npm run build
```

### 9.4 `schedule_value` 校验失败

- `interval` 必须是正整数毫秒字符串
- `cron` 必须是合法 cron 表达式
- `once` 必须是本地时间字符串（不能有 `Z`/时区偏移）

### 9.5 数据丢失风险

如果实例在请求末尾同步前被强制终止，可能丢失当次请求末尾写入。

缓解：

- 平台设置合理 timeout 缓冲
- 关键流程后触发尽快持久化（当前实现已在每次请求结束自动同步）

### 9.6 会话结束与停止

检查点：

- `/chat` 响应中的 `session_end_marker_detected` 是否符合预期
- 若为 `true`，是否已调用 `/control/stop` 或触发平台 `SIGTERM`

## 10. 上线检查清单

- [ ] `GET /health` 正常
- [ ] `POST /chat` 新会话可用
- [ ] `POST /chat` 多轮续接可用
- [ ] `session_end_marker_detected` 行为符合预期
- [ ] `POST /task` / `POST /task/check` 可用
- [ ] `POST /control/stop` 可用
- [ ] `/data` 四类卷挂载生效
- [ ] 外部 Cron 已接入 `/task/check`
- [ ] 日志/告警/限流已配置
- [ ] 密钥未出现在镜像、仓库和明文日志中

---

如需补充 OpenAPI 规范（`openapi.yaml`）或 Terraform/SAM/s.yaml 的完整模板，可在此文档基础上继续扩展。
