# PicoClaw

Serverless-first Claude Agent runtime. Request-driven HTTP API with persistent memory, multi-turn conversations, and scheduled tasks.

Forked from [NanoClaw](https://github.com/qwibitai/nanoclaw) — replaces the always-on multi-channel orchestrator with a single-container, per-request execution model designed for AWS Lambda, Alibaba Cloud FC, and similar platforms.

## Architecture

```
HTTP Request
      |
      v
  Express Router + Auth Middleware
      |
      |--- GET  /health -----> { status, version }
      |--- POST /control/stop -> sync DB, exit
      |
      v
  POST /chat  (or /task/trigger, /task/check)
      |
      |  1. Read/write conversation state
      v
    SQLite (/tmp/messages.db)  <----+
      |                             |
      |  2. Invoke agent            |  4. MCP tools write back
      v                             |
  AgentEngine                       |
  (Claude Agent SDK query())        |
      |                             |
      |  3. Spawns subprocess       |
      v                             |
  MCP Server (stdio) -------->------+
  - send_message
  - schedule_task
  - list/pause/cancel_task
      .
      .  5. After response
      v
  syncDatabaseToVolume()
  /tmp/messages.db  -->  /data/store/messages.db
```

```
Mounted Volumes:
  /data/memory     CLAUDE.md, conversation archives, global memory
  /data/skills     Skill definitions (synced to .claude/skills/ at startup)
  /data/sessions   Claude session state (.claude/)
  /data/store      Persistent SQLite database
```

**Key difference from NanoClaw**: No Docker child containers. The agent runs in the same process as the HTTP server. Skills and memory are volume-mounted, not installed into the source tree.

## Quick Start

### Option 1: One-click script

```bash
git clone git@github.com:breakcafe/picoclaw.git
cd picoclaw
./picoclaw.sh
```

The script will prompt for `ANTHROPIC_API_KEY`, generate an `API_TOKEN`, build the Docker image, start the container, and run a smoke test.

### Option 2: Docker manually

```bash
# Build
docker build --platform linux/amd64 -t picoclaw:latest .

# Run
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

### Option 3: Local Node.js

```bash
npm ci
npm run build
API_TOKEN=dev-token ANTHROPIC_API_KEY=sk-ant-xxx npm start
```

### Verify

```bash
# Health check
curl http://localhost:9000/health

# Send a message
curl -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you do?"}'
```

## API Overview

All routes except `/health` require `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness check |
| POST | `/chat` | Send message, get response (supports SSE) |
| GET | `/chat/:id` | Get conversation metadata |
| POST | `/task` | Create scheduled task (cron/interval/once) |
| GET | `/tasks` | List all tasks |
| PUT | `/task/:id` | Update task |
| DELETE | `/task/:id` | Delete task |
| POST | `/task/trigger` | Manually trigger a task |
| POST | `/task/check` | Execute next due task (for external cron) |
| POST | `/control/stop` | Graceful shutdown with data sync |

Full API documentation: [`docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`](docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md)

OpenAPI spec: `openapi.yaml` / `openapi.json`

Postman collection: `postman_collection.json`

## Data Persistence

PicoClaw stores all state on mounted volumes. The container process itself is stateless.

```
/data/
  memory/           # Agent persona (CLAUDE.md) + conversation archives
    CLAUDE.md        # Main persona definition
    global/          # Global shared memory
    conversations/   # Archived transcripts
  skills/           # Skill definitions (read by agent at startup)
  sessions/         # Claude session state (.claude/)
  store/            # Persistent SQLite (synced from /tmp on every response)
    messages.db
```

On every HTTP response, the local database (`/tmp/messages.db`) is synced to the persistent volume. On shutdown (`SIGTERM` or `POST /control/stop`), a final sync runs before the process exits.

## Skills

Skills are directories mounted at `/data/skills/`. Each skill contains a `SKILL.md` that teaches the agent new capabilities — no source code changes needed.

At container startup, skills are synced to `.claude/skills/` so the Claude agent can discover and use them.

See [`docs/SKILLS_AND_PERSONA_GUIDE.md`](docs/SKILLS_AND_PERSONA_GUIDE.md) for how to write skills and configure the agent persona.

## Serverless Deployment

### AWS Lambda

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```

- Mount EFS to `/data`
- Set `MAX_EXECUTION_MS` below Lambda timeout (e.g., 270000 for 5-min Lambda)
- Use EventBridge Scheduler to call `POST /task/check` every minute

### Alibaba Cloud FC

- Deploy as custom-container with port 9000
- Mount NAS to `/data`
- Configure timer trigger for `/task/check`

See [`docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md`](docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md) for detailed deployment instructions.

## Downstream Integration

For developers building systems that call PicoClaw's HTTP API, see [`docs/API_INTEGRATION_GUIDE.md`](docs/API_INTEGRATION_GUIDE.md).

## Development

```bash
npm ci                    # install dependencies
npm run build             # compile TypeScript
npm test                  # run tests
npm run dev               # development mode (tsx watch)
npm run typecheck         # type checking only
```

Docker workflow:

```bash
make docker-build         # build image
make docker-run           # run with volume mounts
make test-chat            # smoke test /chat endpoint
make test-e2e             # full build + run + test pipeline
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (or OAuth token equivalent) |
| `API_TOKEN` | Bearer token for HTTP API authentication |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9000` | HTTP server port |
| `MAX_EXECUTION_MS` | `300000` | Maximum agent execution time (5 min) |
| `ASSISTANT_NAME` | `Pico` | Agent display name |
| `TZ` | System | Timezone for cron scheduling |
| `LOG_LEVEL` | `info` | Pino log level |
| `STORE_DIR` | `/data/store` | Persistent database volume |
| `MEMORY_DIR` | `/data/memory` | Memory and persona volume |
| `SKILLS_DIR` | `/data/skills` | Skills volume |
| `SESSIONS_DIR` | `/data/sessions` | Session state volume |

## License

See [LICENSE](LICENSE).
