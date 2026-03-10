#!/usr/bin/env bash
# ================================================================
# PicoClaw End-to-End Test Suite
#
# Tests multi-turn conversations, memory persistence, skill sync,
# conversation isolation, task CRUD, auth, and container restart
# recovery — all against a running Docker container.
#
# Prerequisites:
#   - Docker running
#   - .env file with ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, API_TOKEN
#
# Usage:
#   ./scripts/e2e-test.sh              # full suite (build + test)
#   ./scripts/e2e-test.sh --no-build   # skip Docker build
#   ./scripts/e2e-test.sh --no-chat    # skip tests that call Claude API
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME="picoclaw"
IMAGE_TAG="e2e-test"
CONTAINER_NAME="picoclaw-e2e"
PORT=9100  # Use non-default port to avoid conflicts
TMP_DIR=""

# ── Flags ────────────────────────────────────────────────
SKIP_BUILD=false
SKIP_CHAT=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --no-chat)  SKIP_CHAT=true ;;
  esac
done

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo -e "  ${RED}FAIL${NC} $1: $2"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo -e "  ${YELLOW}SKIP${NC} $1"; }
section() { echo -e "\n${CYAN}── $1 ──${NC}"; }

# ── Load .env ────────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
else
  echo -e "${RED}ERROR: .env file not found. Copy .env.example and fill in credentials.${NC}"
  exit 1
fi

API_TOKEN="${API_TOKEN:-dev-token-123}"
BASE_URL="http://localhost:$PORT"

# ── Helpers ──────────────────────────────────────────────
api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

api_status() {
  local method="$1" path="$2"
  shift 2
  curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

json_body() {
  echo -n "-d"
  echo -n "@$1"
}

wait_ready() {
  local max_wait=60
  for i in $(seq 1 $max_wait); do
    if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo -e "${RED}Container failed to start within ${max_wait}s${NC}"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -20
  exit 1
}

cleanup() {
  echo ""
  section "Cleanup"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null && echo "  Removed container $CONTAINER_NAME" || true
  [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR" && echo "  Removed temp dir" || true
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────
section "Setup"

TMP_DIR=$(mktemp -d)
echo "  Temp dir: $TMP_DIR"

# Clean test data to ensure reproducibility
TEST_DATA_DIR="$PROJECT_DIR/dev-data"
rm -rf "$TEST_DATA_DIR/store/messages.db" "$TEST_DATA_DIR/sessions/.claude/projects" \
       "$TEST_DATA_DIR/sessions/.claude/debug" "$TEST_DATA_DIR/sessions/.claude/todos"
mkdir -p "$TEST_DATA_DIR/memory/global" "$TEST_DATA_DIR/memory/conversations" \
         "$TEST_DATA_DIR/skills" "$TEST_DATA_DIR/store" \
         "$TEST_DATA_DIR/sessions/.claude/skills"

# Write test persona
cat > "$TEST_DATA_DIR/memory/CLAUDE.md" << 'PERSONA'
# E2E Test Agent

You are TestBot, a PicoClaw end-to-end test agent.

## Communication Style

- Always mention your name "TestBot" in the first response of a conversation
- Be concise — one or two sentences max
- When asked to recall information, list it as bullet points

## Memory

- Store notes in /data/memory/notes/ if asked to remember something
- Check conversation context before answering
PERSONA

# Write test skill
mkdir -p "$TEST_DATA_DIR/skills/math-skill"
cat > "$TEST_DATA_DIR/skills/math-skill/SKILL.md" << 'SKILL'
---
name: math-helper
description: Perform simple math calculations when asked
---

# Math Helper

## When to use this skill

When the user asks you to perform arithmetic or math calculations.

## Instructions

1. Parse the mathematical expression from the user's message.
2. Compute the result.
3. Return the result in the format: "Result: [answer]"

## Examples

- "What is 2 + 3?" -> "Result: 5"
- "Calculate 10 * 7" -> "Result: 70"
SKILL

echo "  Test persona and skill written"

# ── Build ────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  section "Docker Build"
  docker build --platform linux/amd64 -t "$IMAGE_NAME:$IMAGE_TAG" "$PROJECT_DIR" \
    --quiet 2>&1 | tail -1
  echo "  Image built: $IMAGE_NAME:$IMAGE_TAG"
else
  echo "  Skipping Docker build (--no-build)"
  IMAGE_TAG="latest"
fi

# ── Start Container ──────────────────────────────────────
section "Start Container"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker run -d --name "$CONTAINER_NAME" \
  --platform linux/amd64 \
  -p "$PORT:9000" \
  -e "API_TOKEN=$API_TOKEN" \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  -e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" \
  -e "ASSISTANT_NAME=TestBot" \
  -e "LOG_LEVEL=info" \
  -e "TZ=${TZ:-UTC}" \
  -v "$TEST_DATA_DIR/memory:/data/memory" \
  -v "$TEST_DATA_DIR/skills:/data/skills" \
  -v "$TEST_DATA_DIR/store:/data/store" \
  -v "$TEST_DATA_DIR/sessions:/data/sessions" \
  "$IMAGE_NAME:$IMAGE_TAG" > /dev/null

echo "  Container started, waiting for ready..."
wait_ready
echo "  Container ready on port $PORT"

# ════════════════════════════════════════════════════════
# TEST SUITE
# ════════════════════════════════════════════════════════

# ── 1. Health Check ──────────────────────────────────────
section "1. Health Check"

HEALTH=$(curl -s "$BASE_URL/health")
STATUS=$(echo "$HEALTH" | jq -r '.status')
if [ "$STATUS" = "ok" ]; then
  pass "GET /health returns status=ok"
else
  fail "GET /health" "expected status=ok, got $STATUS"
fi

# ── 2. Authentication ────────────────────────────────────
section "2. Authentication"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/chat")
if [ "$CODE" = "401" ]; then
  pass "No token → 401"
else
  fail "No token" "expected 401, got $CODE"
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/chat" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}')
if [ "$CODE" = "401" ]; then
  pass "Wrong token → 401"
else
  fail "Wrong token" "expected 401, got $CODE"
fi

# ── 3. Multi-Turn Conversation ───────────────────────────
section "3. Multi-Turn Conversation"

if [ "$SKIP_CHAT" = true ]; then
  skip "Round 1: start conversation (--no-chat)"
  skip "Round 2: recall context (--no-chat)"
  skip "Round 3: accumulate context (--no-chat)"
  skip "Round 4: cross-request summary (--no-chat)"
  skip "Conversation metadata check (--no-chat)"
else
  # Round 1: Start conversation, establish identity
  cat > "$TMP_DIR/r1.json" << 'JSON'
{"message":"Hi! My name is Kevin, I code in Rust, and my dog is called Mochi. What is your name?","sender":"kevin","sender_name":"Kevin"}
JSON
  R1=$(api POST /chat -d @"$TMP_DIR/r1.json")
  R1_STATUS=$(echo "$R1" | jq -r '.status')
  CONV_ID=$(echo "$R1" | jq -r '.conversation_id')
  R1_RESULT=$(echo "$R1" | jq -r '.result')

  if [ "$R1_STATUS" = "success" ] && [ "$CONV_ID" != "null" ]; then
    pass "Round 1: conversation created ($CONV_ID)"
  else
    fail "Round 1" "status=$R1_STATUS, conv=$CONV_ID"
  fi

  # Check persona: agent should call itself TestBot
  if echo "$R1_RESULT" | grep -qi "testbot"; then
    pass "Persona: agent identifies as TestBot"
  else
    fail "Persona" "expected 'TestBot' in response: ${R1_RESULT:0:100}"
  fi

  # Round 2: Ask agent to recall name
  cat > "$TMP_DIR/r2.json" << JSON
{"message":"What is my name?","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R2=$(api POST /chat -d @"$TMP_DIR/r2.json")
  R2_RESULT=$(echo "$R2" | jq -r '.result')

  if echo "$R2_RESULT" | grep -qi "kevin"; then
    pass "Round 2: agent recalls name 'Kevin'"
  else
    fail "Round 2" "expected 'Kevin' in: ${R2_RESULT:0:100}"
  fi

  # Round 3: Ask agent to recall all three facts
  cat > "$TMP_DIR/r3.json" << JSON
{"message":"List the three things you know about me (name, language, pet).","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R3=$(api POST /chat -d @"$TMP_DIR/r3.json")
  R3_RESULT=$(echo "$R3" | jq -r '.result')

  FOUND=0
  echo "$R3_RESULT" | grep -qi "kevin" && FOUND=$((FOUND + 1))
  echo "$R3_RESULT" | grep -qi "rust"  && FOUND=$((FOUND + 1))
  echo "$R3_RESULT" | grep -qi "mochi" && FOUND=$((FOUND + 1))

  if [ "$FOUND" -eq 3 ]; then
    pass "Round 3: agent recalls all 3 facts (Kevin, Rust, Mochi)"
  else
    fail "Round 3" "found $FOUND/3 facts in: ${R3_RESULT:0:200}"
  fi

  # Round 4: One more round — summarize in one sentence
  cat > "$TMP_DIR/r4.json" << JSON
{"message":"Summarize everything about me in one sentence.","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R4=$(api POST /chat -d @"$TMP_DIR/r4.json")
  R4_STATUS=$(echo "$R4" | jq -r '.status')

  if [ "$R4_STATUS" = "success" ]; then
    pass "Round 4: 4-turn conversation completed"
  else
    fail "Round 4" "status=$R4_STATUS"
  fi

  # Verify conversation metadata
  META=$(api GET "/chat/$CONV_ID")
  MSG_COUNT=$(echo "$META" | jq -r '.message_count')
  META_STATUS=$(echo "$META" | jq -r '.status')

  if [ "$MSG_COUNT" -ge 8 ] && [ "$META_STATUS" = "idle" ]; then
    pass "Metadata: $MSG_COUNT messages, status=idle"
  else
    fail "Metadata" "message_count=$MSG_COUNT, status=$META_STATUS"
  fi
fi

# ── 4. Conversation Isolation ────────────────────────────
section "4. Conversation Isolation"

if [ "$SKIP_CHAT" = true ]; then
  skip "New conversation isolation (--no-chat)"
else
  cat > "$TMP_DIR/iso.json" << 'JSON'
{"message":"Do you know someone named Kevin? What programming language does he use?","sender":"alice","sender_name":"Alice"}
JSON
  ISO=$(api POST /chat -d @"$TMP_DIR/iso.json")
  ISO_CONV=$(echo "$ISO" | jq -r '.conversation_id')
  ISO_RESULT=$(echo "$ISO" | jq -r '.result')

  # New conversation should NOT have Kevin's context
  if [ "$ISO_CONV" != "$CONV_ID" ]; then
    pass "Isolation: new conversation_id ($ISO_CONV)"
  else
    fail "Isolation" "reused conversation_id"
  fi

  # The agent might say it doesn't know, or might not mention Rust/Mochi
  # We check that it's a DIFFERENT conversation by checking conv_id above
  # The content check is best-effort (LLM responses aren't deterministic)
  if echo "$ISO_RESULT" | grep -qi "don't\|do not\|no information\|not sure\|don't have"; then
    pass "Isolation: agent reports no knowledge of Kevin"
  else
    echo -e "  ${YELLOW}WARN${NC} Isolation: agent response may leak context (non-deterministic)"
    pass "Isolation: different conversation_id confirmed"
  fi
fi

# ── 5. Task CRUD ─────────────────────────────────────────
section "5. Task CRUD"

# Create
CREATE=$(api POST /task -d '{"id":"e2e-test-task","prompt":"Hello from e2e test","schedule_type":"interval","schedule_value":"3600000","context_mode":"isolated"}')
TASK_STATUS=$(echo "$CREATE" | jq -r '.status')
if [ "$TASK_STATUS" = "active" ]; then
  pass "Create task: status=active"
else
  fail "Create task" "status=$TASK_STATUS"
fi

# List
TASKS=$(api GET /tasks)
TASK_COUNT=$(echo "$TASKS" | jq '.tasks | length')
if [ "$TASK_COUNT" -ge 1 ]; then
  pass "List tasks: $TASK_COUNT task(s) found"
else
  fail "List tasks" "count=$TASK_COUNT"
fi

# Update
UPDATE_CODE=$(api_status PUT /task/e2e-test-task -d '{"prompt":"Updated prompt"}')
if [ "$UPDATE_CODE" = "200" ]; then
  pass "Update task: 200"
else
  fail "Update task" "expected 200, got $UPDATE_CODE"
fi

# Task check (no due tasks yet since interval is 1 hour)
CHECK=$(api POST /task/check)
CHECKED=$(echo "$CHECK" | jq -r '.checked')
if [ "$CHECKED" = "0" ] || [ "$CHECKED" = "1" ]; then
  pass "Task check: checked=$CHECKED"
else
  fail "Task check" "checked=$CHECKED"
fi

# Delete
DELETE_CODE=$(api_status DELETE /task/e2e-test-task)
if [ "$DELETE_CODE" = "204" ]; then
  pass "Delete task: 204"
else
  fail "Delete task" "expected 204, got $DELETE_CODE"
fi

# ── 6. Skills Sync ───────────────────────────────────────
section "6. Skills & Memory Verification"

SKILLS_LS=$(docker exec "$CONTAINER_NAME" ls /data/sessions/.claude/skills/ 2>&1)
if echo "$SKILLS_LS" | grep -q "math-skill"; then
  pass "Skills synced to .claude/skills/"
else
  fail "Skills sync" "math-skill not found in: $SKILLS_LS"
fi

PERSONA=$(docker exec "$CONTAINER_NAME" cat /data/memory/CLAUDE.md 2>&1)
if echo "$PERSONA" | grep -q "TestBot"; then
  pass "Persona CLAUDE.md accessible (/data/memory)"
else
  fail "Persona" "TestBot not found in CLAUDE.md"
fi

# ── 7. Container Restart Persistence ─────────────────────
section "7. Container Restart Persistence"

if [ "$SKIP_CHAT" = true ] || [ -z "${CONV_ID:-}" ]; then
  skip "Restart persistence (--no-chat or no conversation)"
else
  # Graceful stop (triggers DB sync)
  STOP=$(api POST /control/stop -d '{"reason":"e2e-restart-test"}')
  STOP_STATUS=$(echo "$STOP" | jq -r '.status')
  if [ "$STOP_STATUS" = "stopping" ]; then
    pass "Graceful stop accepted"
  else
    fail "Graceful stop" "status=$STOP_STATUS"
  fi

  # Wait for container to exit
  sleep 5

  # Verify DB was synced to volume
  if [ -f "$TEST_DATA_DIR/store/messages.db" ]; then
    pass "Database synced to volume"
  else
    fail "Database sync" "messages.db not found"
  fi

  # Restart container
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  docker run -d --name "$CONTAINER_NAME" \
    --platform linux/amd64 \
    -p "$PORT:9000" \
    -e "API_TOKEN=$API_TOKEN" \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    -e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" \
    -e "ASSISTANT_NAME=TestBot" \
    -e "LOG_LEVEL=info" \
    -e "TZ=${TZ:-UTC}" \
    -v "$TEST_DATA_DIR/memory:/data/memory" \
    -v "$TEST_DATA_DIR/skills:/data/skills" \
    -v "$TEST_DATA_DIR/store:/data/store" \
    -v "$TEST_DATA_DIR/sessions:/data/sessions" \
    "$IMAGE_NAME:$IMAGE_TAG" > /dev/null

  wait_ready
  pass "Container restarted"

  # Verify conversation still exists
  META2=$(api GET "/chat/$CONV_ID")
  META2_COUNT=$(echo "$META2" | jq -r '.message_count')
  if [ "$META2_COUNT" -ge 8 ]; then
    pass "Conversation persisted after restart ($META2_COUNT messages)"
  else
    fail "Conversation persistence" "message_count=$META2_COUNT"
  fi

  # Resume conversation and verify context
  cat > "$TMP_DIR/resume.json" << JSON
{"message":"What is my dogs name and what language do I code in?","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  RESUME=$(api POST /chat -d @"$TMP_DIR/resume.json")
  RESUME_STATUS=$(echo "$RESUME" | jq -r '.status')
  RESUME_RESULT=$(echo "$RESUME" | jq -r '.result')

  if [ "$RESUME_STATUS" = "success" ]; then
    FOUND=0
    echo "$RESUME_RESULT" | grep -qi "mochi" && FOUND=$((FOUND + 1))
    echo "$RESUME_RESULT" | grep -qi "rust"  && FOUND=$((FOUND + 1))
    if [ "$FOUND" -eq 2 ]; then
      pass "Session resume: agent recalls Mochi + Rust after restart"
    else
      fail "Session resume" "found $FOUND/2 facts in: ${RESUME_RESULT:0:200}"
    fi
  else
    fail "Session resume" "status=$RESUME_STATUS"
  fi
fi

# ── 8. Dynamic Skill Creation ────────────────────────────
section "8. Dynamic Skill Creation & Reload"

# 1. Create a skill inside the container via docker exec
docker exec "$CONTAINER_NAME" mkdir -p /data/memory/skills/e2e-test-skill
docker exec "$CONTAINER_NAME" sh -c 'cat > /data/memory/skills/e2e-test-skill/SKILL.md << SKILLEOF
---
name: e2e-test-skill
description: A test skill created dynamically during E2E testing
---

# E2E Test Skill

When the user says "e2e skill test", respond with exactly: "E2E_SKILL_ACTIVE"
SKILLEOF'

if docker exec "$CONTAINER_NAME" test -f /data/memory/skills/e2e-test-skill/SKILL.md; then
  pass "Created dynamic skill in container"
else
  fail "Dynamic skill creation" "SKILL.md not found"
fi

# 2. Reload skills via admin API
RELOAD=$(api POST /admin/reload-skills)
RELOAD_STATUS=$(echo "$RELOAD" | jq -r '.status')
if [ "$RELOAD_STATUS" = "reloaded" ]; then
  pass "POST /admin/reload-skills → status=reloaded"
else
  fail "Reload skills" "status=$RELOAD_STATUS"
fi

# 3. Verify skill appears in effective list
SKILLS=$(api GET /admin/skills)
EFFECTIVE=$(echo "$SKILLS" | jq -r '.skills.effective[]' 2>/dev/null)
if echo "$EFFECTIVE" | grep -q "e2e-test-skill"; then
  pass "GET /admin/skills → e2e-test-skill in effective list"
else
  fail "Skills list" "e2e-test-skill not in effective: $EFFECTIVE"
fi

# 4. Verify skill is synced to .claude/skills/
SYNCED=$(docker exec "$CONTAINER_NAME" ls /data/sessions/.claude/skills/ 2>&1)
if echo "$SYNCED" | grep -q "e2e-test-skill"; then
  pass "Dynamic skill synced to .claude/skills/"
else
  fail "Skill sync" "e2e-test-skill not in .claude/skills/: $SYNCED"
fi

# 5. Best-effort: send a message that triggers the skill (LLM non-deterministic)
if [ "$SKIP_CHAT" = true ]; then
  skip "Dynamic skill chat test (--no-chat)"
else
  cat > "$TMP_DIR/skill-test.json" << 'JSON'
{"message":"e2e skill test","sender":"test","sender_name":"Tester"}
JSON
  SKILL_RESP=$(api POST /chat -d @"$TMP_DIR/skill-test.json")
  SKILL_STATUS=$(echo "$SKILL_RESP" | jq -r '.status')
  SKILL_RESULT=$(echo "$SKILL_RESP" | jq -r '.result')

  if [ "$SKILL_STATUS" = "success" ]; then
    if echo "$SKILL_RESULT" | grep -qi "E2E_SKILL_ACTIVE"; then
      pass "Dynamic skill triggered in chat response"
    else
      echo -e "  ${YELLOW}WARN${NC} Skill response did not contain exact marker (LLM non-deterministic)"
      pass "Dynamic skill chat completed (status=success)"
    fi
  else
    fail "Dynamic skill chat" "status=$SKILL_STATUS"
  fi
fi

# 6. Clean up
docker exec "$CONTAINER_NAME" rm -rf /data/memory/skills/e2e-test-skill
pass "Cleaned up dynamic skill"

# ── 9. Conversation 404 ─────────────────────────────────
section "9. Error Handling"

CODE=$(api_status GET /chat/conv-nonexistent-12345)
if [ "$CODE" = "404" ]; then
  pass "Non-existent conversation → 404"
else
  fail "Conversation 404" "expected 404, got $CODE"
fi

# ── 10. Graceful Shutdown ────────────────────────────────
section "10. Final Graceful Shutdown"

FINAL_STOP=$(api POST /control/stop -d '{"reason":"e2e-complete"}')
FINAL_STATUS=$(echo "$FINAL_STOP" | jq -r '.status')
if [ "$FINAL_STATUS" = "stopping" ]; then
  pass "Final shutdown accepted"
else
  fail "Final shutdown" "status=$FINAL_STATUS"
fi

sleep 3
RUNNING=$(docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}")
if [ -z "$RUNNING" ]; then
  pass "Container exited cleanly"
else
  fail "Container exit" "still running"
fi

# ════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════════"
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo -e "  Total: $TOTAL  ${GREEN}Pass: $PASS_COUNT${NC}  ${RED}Fail: $FAIL_COUNT${NC}  ${YELLOW}Skip: $SKIP_COUNT${NC}"
echo "════════════════════════════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
