# PicoClaw

Serverless 优先的 Claude Agent 运行时。基于 HTTP API 按需触发，支持持久记忆、多轮对话和定时任务。

从 [NanoClaw](https://github.com/qwibitai/nanoclaw) 裁剪而来 — 将常驻多渠道编排器替换为单容器按需执行模型，适用于 AWS Lambda、阿里云函数计算等平台。

## 架构

```
HTTP 请求
      |
      v
  Express 路由 + 认证中间件
      |
      |--- GET  /health -----> { status, version }
      |--- POST /control/stop -> 同步 DB，退出
      |
      v
  POST /chat（或 /task/trigger、/task/check）
      |
      |  1. 读写对话状态
      v
    SQLite (/tmp/messages.db)  <----+
      |                             |
      |  2. 调用 Agent              |  4. MCP 工具回写
      v                             |
  AgentEngine                       |
  (Claude Agent SDK query())        |
      |                             |
      |  3. 启动子进程              |
      v                             |
  MCP Server (stdio) -------->------+
  - send_message
  - schedule_task
  - list/pause/cancel_task
      .
      .  5. 响应结束后
      v
  syncDatabaseToVolume()
  /tmp/messages.db  -->  /data/store/messages.db
```

```
外挂卷：
  /data/memory     CLAUDE.md、对话归档、全局记忆
  /data/skills     技能定义（启动时同步到 .claude/skills/）
  /data/sessions   Claude 会话状态（.claude/）
  /data/store      持久化 SQLite 数据库
```

**与 NanoClaw 的关键区别**：不再使用 Docker 子容器。Agent 与 HTTP 服务器在同一进程中运行。Skills 和 Memory 通过文件卷外挂，而非安装到源码目录。

## 快速开始

### 方式 1：一键脚本

```bash
git clone git@github.com:breakcafe/picoclaw.git
cd picoclaw
./picoclaw.sh
```

脚本会提示输入 `ANTHROPIC_API_KEY`，自动生成 `API_TOKEN`，构建 Docker 镜像，启动容器并执行冒烟测试。

### 方式 2：手动 Docker

```bash
# 构建
docker build --platform linux/amd64 -t picoclaw:latest .

# 运行
docker run --rm -it \
  -p 9000:9000 \
  -e API_TOKEN=your-token \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -v $(pwd)/dev-data/memory:/data/memory \
  -v $(pwd)/dev-data/skills:/data/skills \
  -v $(pwd)/dev-data/store:/data/store \
  -v $(pwd)/dev-data/sessions:/data/sessions \
  picoclaw:latest
```

### 方式 3：本地 Node.js

```bash
npm ci
npm run build
API_TOKEN=dev-token ANTHROPIC_API_KEY=sk-ant-xxx npm start
```

### 验证

```bash
# 健康检查
curl http://localhost:9000/health

# 发送消息
curl -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "你好，你能做什么？"}'
```

## API 概览

除 `/health` 外，所有接口需要 `Authorization: Bearer <API_TOKEN>`。

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 存活检查 |
| POST | `/chat` | 发送消息，获取回复（支持 SSE） |
| GET | `/chat/:id` | 查询对话元数据 |
| POST | `/task` | 创建定时任务（cron/interval/once） |
| GET | `/tasks` | 列出所有任务 |
| PUT | `/task/:id` | 更新任务 |
| DELETE | `/task/:id` | 删除任务 |
| POST | `/task/trigger` | 手动触发指定任务 |
| POST | `/task/check` | 执行下一个到期任务（供外部 Cron 调用） |
| POST | `/control/stop` | 优雅停止并同步数据 |

完整 API 文档：[`docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`](docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md)

OpenAPI 规范���`openapi.yaml` / `openapi.json`

Postman 集合：`postman_collection.json`

## 数据持久化

PicoClaw 将所有状态存储在外挂卷上，容器进程本身是无状态的。

```
/data/
  memory/           # Agent 人设 (CLAUDE.md) + 对话归档
    CLAUDE.md        # 主要人设定义
    global/          # 全局共享记忆
    conversations/   # 归档的对话记录
  skills/           # 技能定义（启动时由 Agent 读取）
  sessions/         # Claude 会话状态 (.claude/)
  store/            # 持久化 SQLite（每次响应后从 /tmp 同步）
    messages.db
```

每次 HTTP 响应后，本地数据库 (`/tmp/messages.db`) 会同步到持久卷。关闭时（`SIGTERM` 或 `POST /control/stop`），进程退出前会执行最终同步。

## 技能（Skills）

技能是挂载在 `/data/skills/` 下的目录。每个技能包含一个 `SKILL.md`，用于教会 Agent 新的能力 — 无需修改源码。

容器启动时，技能会被同步到 `.claude/skills/`，以便 Claude Agent 发现和使用。

详见 [`docs/SKILLS_AND_PERSONA_GUIDE.md`](docs/SKILLS_AND_PERSONA_GUIDE.md) 了解如何编写技能和配置 Agent 人设。

## Serverless 部署

### AWS Lambda

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```

- 挂载 EFS 到 `/data`
- 将 `MAX_EXECUTION_MS` 设置低于 Lambda 超时（如 5 分钟 Lambda 设 270000）
- 用 EventBridge Scheduler 每分钟调用 `POST /task/check`

### 阿里云函数计算

- 部署为自定义容器，端口 9000
- NAS 挂载到 `/data`
- 配置定时触发器调用 `/task/check`

详见 [`docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`](docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md) 获取完整部署指南。

## 下游接入

面向调用 PicoClaw HTTP API 的开发者，详见 [`docs/API_INTEGRATION_GUIDE.md`](docs/API_INTEGRATION_GUIDE.md)。

## 开发

```bash
npm ci                    # 安装依赖
npm run build             # 编译 TypeScript
npm test                  # 运行测试
npm run dev               # 开发模式（tsx watch）
npm run typecheck         # 仅类型检查
```

Docker 工作流：

```bash
make docker-build         # 构建镜像
make docker-run           # 带卷挂载运行
make test-chat            # 冒烟测试 /chat 接口
make test-e2e             # 完整 build + run + test 流程
```

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 密钥（或 OAuth token） |
| `API_TOKEN` | HTTP API 认证 Bearer Token |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9000` | HTTP 服务端口 |
| `MAX_EXECUTION_MS` | `300000` | Agent 最大执行时间（5 分钟） |
| `ASSISTANT_NAME` | `Pico` | Agent 显示名称 |
| `TZ` | 系统时区 | Cron 调度时区 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `STORE_DIR` | `/data/store` | 持久化数据库卷 |
| `MEMORY_DIR` | `/data/memory` | 记忆和人设卷 |
| `SKILLS_DIR` | `/data/skills` | 技能卷 |
| `SESSIONS_DIR` | `/data/sessions` | 会话状态卷 |

## 许可证

详见 [LICENSE](LICENSE)。
