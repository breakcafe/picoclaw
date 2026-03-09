# PicoClaw（Serverless 版）

PicoClaw 是 NanoClaw 的 Serverless 裁剪版本。核心仍然使用 Claude Agent SDK，但把原来的常驻多渠道架构改成 HTTP 按需触发。

## 主要变化

- Agent 不再通过每次 `docker run` 独立容器执行，而是在同一容器/进程内执行。
- Skills、Memory、Sessions、SQLite 通过文件卷外挂（`/data/*`）。
- 对话入口从 Telegram/WhatsApp/Slack 改为 HTTP API。
- 多轮会话状态保存在 SQLite + Claude session resume 元数据。
- 定时任务由外部 Cron 调用 `/task/check` 驱动。

详细运维与部署手册：`docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`。

## API 列表

- `GET /health`
- `POST /chat`
- `GET /chat/:conversation_id`
- `POST /task`
- `GET /tasks`
- `PUT /task/:task_id`
- `DELETE /task/:task_id`
- `POST /task/trigger`
- `POST /task/check`
- `POST /control/stop`

除 `/health` 外都需要 Bearer Token：

```http
Authorization: Bearer <API_TOKEN>
```

在 Serverless 场景下，memory 与 conversation history 是核心能力而不是可选项。需要通过挂载持久化目录（如 OSS/NAS/EFS 对应路径）复用 `/data/memory`、`/data/store`、`/data/sessions` 来实现跨请求的个性化连续体验。

## 本地开发

```bash
npm ci
npm run build
npm start
```

Docker：

```bash
make docker-build
make docker-run
```

一键启动并冒烟测试：

```bash
./picoclaw.sh
```

通过 API 优雅停止：

```bash
./picoclaw.sh stop-api
```

## 关键环境变量

必填：

- `ANTHROPIC_API_KEY`（或 Claude Code OAuth Token）
- `API_TOKEN`

可选：

- `PORT`（默认 `9000`）
- `MAX_EXECUTION_MS`（默认 `300000`）
- `ASSISTANT_NAME`（默认 `Pico`）
- `TZ`（默认系统时区）

## 镜像构建

```bash
docker build --platform linux/amd64 -t picoclaw:latest .
```

AWS Lambda 版（含 Lambda Web Adapter）：

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```
