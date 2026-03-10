IMAGE_NAME := picoclaw
IMAGE_TAG := latest
CONTAINER_NAME := picoclaw-dev
PORT := 9000

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Build ────────────────────────────────────────────────

build-ts: ## Compile TypeScript to dist/
	npm run build

dev: build-ts ## Run from compiled dist/ (build first)
	node dist/index.js

dev-watch: ## Run from source with tsx watch (no build needed)
	npx tsx --watch src/index.ts

# ── Docker ───────────────────────────────────────────────

docker-build: ## Build Docker image (multi-stage, no local Node.js needed)
	docker build --platform linux/amd64 -t $(IMAGE_NAME):$(IMAGE_TAG) .

docker-build-lambda: ## Build Docker image with Lambda Web Adapter
	docker build --platform linux/amd64 --build-arg ENABLE_LAMBDA_ADAPTER=true -t $(IMAGE_NAME):lambda .

docker-run: _ensure-data-dirs ## Run container interactively with volume mounts
	docker run --rm -it \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		--env-file .env \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/skills:/data/skills \
		-v $(CURDIR)/dev-data/store:/data/store \
		-v $(CURDIR)/dev-data/sessions:/data/sessions \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-bg: _ensure-data-dirs ## Run container in background
	docker run -d --rm \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		--env-file .env \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/skills:/data/skills \
		-v $(CURDIR)/dev-data/store:/data/store \
		-v $(CURDIR)/dev-data/sessions:/data/sessions \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-stop: ## Stop the running container
	docker stop $(CONTAINER_NAME) 2>/dev/null || true

docker-logs: ## Tail container logs
	docker logs -f $(CONTAINER_NAME)

# ── Test ─────────────────────────────────────────────────

test: ## Run unit tests (vitest)
	npm test

test-health: ## Smoke test: GET /health
	@curl -s http://localhost:$(PORT)/health | jq .

test-chat: ## Smoke test: POST /chat with a sample message
	@curl -s -X POST http://localhost:$(PORT)/chat \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"message":"你好，请简单介绍一下你自己。","sender":"test","sender_name":"测试用户"}' \
		| jq .

test-task-create: ## Smoke test: create a sample scheduled task
	@curl -s -X POST http://localhost:$(PORT)/task \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"prompt":"报告当前系统时间和日期","schedule_type":"interval","schedule_value":"300000","context_mode":"isolated"}' \
		| jq .

test-task-check: ## Smoke test: check and execute due tasks
	@curl -s -X POST http://localhost:$(PORT)/task/check \
		-H "Authorization: Bearer $(API_TOKEN)" \
		| jq .

test-e2e: docker-build docker-run-bg _wait-ready test-health test-chat docker-stop ## End-to-end: build, run, smoke test, stop

# ── Cleanup ──────────────────────────────────────────────

clean: docker-stop ## Stop container and remove images
	docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || true
	docker rmi $(IMAGE_NAME):lambda 2>/dev/null || true

clean-data: ## Remove local dev store and sessions (keeps memory and skills)
	rm -rf dev-data/store dev-data/sessions

# ── Internal ─────────────────────────────────────────────

_ensure-data-dirs:
	@mkdir -p dev-data/memory/global dev-data/memory/conversations
	@mkdir -p dev-data/skills
	@mkdir -p dev-data/store
	@mkdir -p dev-data/sessions/.claude/skills
	@test -f dev-data/memory/CLAUDE.md || printf '# PicoClaw Memory\n\nYou are a helpful assistant.\n' > dev-data/memory/CLAUDE.md

_wait-ready:
	@for i in $$(seq 1 30); do \
		curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 && break; \
		sleep 1; \
	done
	@curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 \
		|| (echo "Server failed to start" && docker logs $(CONTAINER_NAME) && exit 1)

# ── Help ─────────────────────────────────────────────────

.DEFAULT_GOAL := help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: build-ts dev dev-watch docker-build docker-build-lambda docker-run docker-run-bg \
	docker-stop docker-logs test test-health test-chat test-task-create test-task-check \
	test-e2e clean clean-data help _ensure-data-dirs _wait-ready
