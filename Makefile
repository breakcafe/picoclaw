IMAGE_NAME := picoclaw
IMAGE_TAG := latest
CONTAINER_NAME := picoclaw-dev
PORT := 9000

ifneq (,$(wildcard .env))
include .env
export
endif

build-ts:
	npm run build

dev: build-ts
	node dist/index.js

dev-watch:
	npx tsx --watch src/index.ts

docker-build: build-ts
	docker build --platform linux/amd64 -t $(IMAGE_NAME):$(IMAGE_TAG) .

docker-build-lambda: build-ts
	docker build --platform linux/amd64 --build-arg ENABLE_LAMBDA_ADAPTER=true -t $(IMAGE_NAME):lambda .

docker-run: _ensure-data-dirs
	docker run --rm -it \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/skills:/data/skills \
		-v $(CURDIR)/dev-data/store:/data/store \
		-v $(CURDIR)/dev-data/sessions:/data/sessions \
		-e ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) \
		-e API_TOKEN=$(API_TOKEN) \
		-e ASSISTANT_NAME=$(ASSISTANT_NAME) \
		-e MAX_EXECUTION_MS=$(MAX_EXECUTION_MS) \
		-e LOG_LEVEL=debug \
		-e TZ=$(TZ) \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-bg: _ensure-data-dirs
	docker run -d --rm \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/skills:/data/skills \
		-v $(CURDIR)/dev-data/store:/data/store \
		-v $(CURDIR)/dev-data/sessions:/data/sessions \
		-e ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) \
		-e API_TOKEN=$(API_TOKEN) \
		-e ASSISTANT_NAME=$(ASSISTANT_NAME) \
		-e MAX_EXECUTION_MS=$(MAX_EXECUTION_MS) \
		-e LOG_LEVEL=debug \
		-e TZ=$(TZ) \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-stop:
	docker stop $(CONTAINER_NAME) 2>/dev/null || true

docker-logs:
	docker logs -f $(CONTAINER_NAME)

test-health:
	@curl -s http://localhost:$(PORT)/health | jq .

test-chat:
	@curl -s -X POST http://localhost:$(PORT)/chat \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"message":"你好，请简单介绍一下你自己。","sender":"test","sender_name":"测试用户"}' \
		| jq .

test-task-create:
	@curl -s -X POST http://localhost:$(PORT)/task \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"prompt":"报告当前系统时间和日期","schedule_type":"interval","schedule_value":"300000","context_mode":"isolated"}' \
		| jq .

test-task-check:
	@curl -s -X POST http://localhost:$(PORT)/task/check \
		-H "Authorization: Bearer $(API_TOKEN)" \
		| jq .

test-e2e: docker-build docker-run-bg _wait-ready test-health test-chat docker-stop

clean: docker-stop
	docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || true
	docker rmi $(IMAGE_NAME):lambda 2>/dev/null || true

clean-data:
	rm -rf dev-data/store dev-data/sessions

_ensure-data-dirs:
	@mkdir -p dev-data/memory/global dev-data/memory/conversations
	@mkdir -p dev-data/skills
	@mkdir -p dev-data/store
	@mkdir -p dev-data/sessions/.claude/skills
	@test -f dev-data/memory/CLAUDE.md || echo "# Assistant Memory\n\nYou are a helpful assistant." > dev-data/memory/CLAUDE.md

_wait-ready:
	@for i in $$(seq 1 30); do \
		curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 && break; \
		sleep 1; \
	done
	@curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 \
		|| (echo "Server failed to start" && docker logs $(CONTAINER_NAME) && exit 1)

.DEFAULT_GOAL := help
help:
	@echo "PicoClaw commands"
	@echo "  make build-ts"
	@echo "  make dev"
	@echo "  make docker-build"
	@echo "  make docker-run"
	@echo "  make test-chat"

.PHONY: build-ts dev dev-watch docker-build docker-build-lambda docker-run docker-run-bg \
	docker-stop docker-logs test-health test-chat test-task-create test-task-check \
	test-e2e clean clean-data help _ensure-data-dirs _wait-ready
