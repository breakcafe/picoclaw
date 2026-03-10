# PicoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| HTTP caller (with valid token) | Trusted | Bearer token authenticates the caller |
| HTTP caller (no token) | Untrusted | Only `/health` is accessible |
| Agent (Claude SDK) | Sandboxed | Runs with controlled tool set, no direct secret access |
| MCP Server subprocess | Internal | Shares SQLite, scoped by conversation ownership |
| External cron trigger | Trusted | Must provide Bearer token for `/task/check` |

## Security Boundaries

### 1. HTTP API Authentication (Primary Boundary)

All endpoints except `/health` require a Bearer token:

```http
Authorization: Bearer <API_TOKEN>
```

- `API_TOKEN` is set via environment variable at deployment time.
- Missing or invalid tokens receive `401 Unauthorized`.
- If `API_TOKEN` is not configured, the server returns `500` to prevent open access.

### 2. Secret Isolation

The agent never sees deployment secrets:

- `ANTHROPIC_BASE_URL` is passed to the SDK as an environment variable. While not a secret, it should be injected at deployment time alongside `ANTHROPIC_API_KEY` for consistency.
- `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are unset from the Bash environment in the `preToolUse` hook before any shell command executes.
- `API_TOKEN` is only used by the Express middleware; the agent cannot read it.
- Secrets and configuration must be injected via environment variables or cloud secret managers — never baked into the Docker image.

### 3. Filesystem Boundaries

PicoClaw operates within well-defined mounted volumes:

| Path | Purpose | Access |
|------|---------|--------|
| `/data/memory` | CLAUDE.md, conversation archives | Read/Write |
| `/data/skills` | Skill definitions | Read-only (synced to session) |
| `/data/sessions` | Claude session state (.claude/) | Read/Write |
| `/data/store` | Persistent SQLite database | Read/Write |
| `/tmp` | Local working database | Read/Write (ephemeral) |

The agent has full Bash access within the container, but the container itself limits the blast radius.

### 4. MCP Tool Ownership

The MCP server enforces ownership rules:

- **Main session** (`PICOCLAW_IS_MAIN=1`): Can list and manage all tasks across conversations. (Legacy `NANOCLAW_IS_MAIN` is accepted as fallback.)
- **Non-main sessions**: Can only manage tasks belonging to their `conversation_id`.
- `send_message` writes are scoped to the current conversation.

### 5. Database Integrity

- Foreign key constraints are enforced (`PRAGMA foreign_keys = ON`).
- WAL mode prevents corruption from concurrent reads during sync.
- Database sync uses `wal_checkpoint(TRUNCATE)` before file copy to ensure consistency.

## Deployment Recommendations

### Network

- Place PicoClaw behind an API Gateway or reverse proxy (AWS API Gateway, ALB, Nginx).
- Use TLS termination at the gateway level.
- Restrict direct access to the container port.

### Secrets

- Use cloud secret managers (AWS Secrets Manager, Alibaba Cloud KMS) for `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `API_TOKEN`.
- Rotate `API_TOKEN` periodically.
- Never commit `.env` to version control.

### Monitoring

- Monitor `status=timeout` and `status=error` rates.
- Alert on unexpected `401` patterns (potential brute force).
- Track `/task/check remaining` to detect task backlog.

### Container Hardening

- Run as non-root user (`node`, uid 1000) — already configured in Dockerfile.
- Use read-only root filesystem where possible.
- Set memory and CPU limits at the cloud platform level.

## Security Assessment

| Area | Rating | Details |
|------|--------|---------|
| Authentication | Good | Bearer token; unauthenticated access limited to `/health` (version info only) |
| Secret isolation | Good | PreToolUse hook scrubs `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `API_TOKEN` from Bash environment |
| File isolation | Acceptable | Agent can access all files within the container (by design); volume mount boundaries limit scope |
| Database security | Acceptable | No encryption at rest; relies on volume permission controls |
| Injection protection | Good | Zod schema validation on MCP tool inputs; XML escaping on message output |
| Log security | Good | Structured pino logging; full request bodies are not logged |
| Concurrency safety | Good | Per-conversation mutex lock prevents concurrent agent execution on same conversation; different conversations run in parallel; conflict returns 409 |

## Known Limitations

1. **Single-instance SQLite**: SQLite does not support multi-writer concurrency across instances. Cloud platform concurrency controls should limit to one active instance per conversation scope.
2. **No request-level rate limiting**: Rate limiting should be implemented at the API Gateway layer.
3. **Agent Bash access**: The agent can execute arbitrary commands within the container. This is by design (Claude Code requires it), but the container boundary limits impact.
