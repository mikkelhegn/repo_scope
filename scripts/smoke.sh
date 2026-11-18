#!/usr/bin/env bash
# Smoke test for a running RepoScope instance.
#
#   BASE=http://127.0.0.1:3000 ./scripts/smoke.sh
#
# With SPIN_VARIABLE_ACCESS_TOKEN set, also pass the token:
#   ACCESS_TOKEN=... ./scripts/smoke.sh
#
# Requires the mock model for a deterministic run:
#   node scripts/mock-openai.mjs &
#   SPIN_VARIABLE_OPENAI_API_KEY=mock \
#   SPIN_VARIABLE_OPENAI_BASE_URL=http://127.0.0.1:4010 \
#   SPIN_VARIABLE_MODEL=mock-codeact ./run.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
BASE="${BASE%/}"
TOKEN="${ACCESS_TOKEN:-}"
TMP_DIR="$(mktemp -d)"
COOKIE_JAR="$TMP_DIR/cookies.txt"
BODY_FILE="$TMP_DIR/chat.ndjson"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "health: $BASE/api/health"
health="$(curl -fsS --max-time 10 "$BASE/api/health")" || fail "health endpoint unreachable"
case "$health" in
  *'"ok":true'*) ;;
  *) fail "unexpected health response: $health" ;;
esac
echo "  $health"

if [[ -n "$TOKEN" ]]; then
  echo "auth: POST /api/auth"
  curl -fsS --max-time 10 -c "$COOKIE_JAR" \
    -H 'content-type: application/json' \
    -d "{\"token\":\"$TOKEN\"}" \
    "$BASE/api/auth" >/dev/null || fail "access token rejected"
fi

echo "chat: POST /api/chat"
status="$(curl -sS --max-time 180 -o "$BODY_FILE" -w '%{http_code}' \
  -b "$COOKIE_JAR" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Use the sandbox to inspect the GitHub repository spinframework/spin and summarize it.","history":[]}' \
  "$BASE/api/chat")" || fail "chat request failed"

if [[ "$status" != "200" ]]; then
  echo "response body:" >&2
  cat "$BODY_FILE" >&2
  fail "chat returned HTTP $status"
fi

if ! grep -q '"t":"tool_start"' "$BODY_FILE"; then
  fail "stream had no tool_start event (is the model emitting a tool call?)"
fi
if ! grep -q '"t":"tool_end"' "$BODY_FILE"; then
  fail "stream had no tool_end event (did the sandbox run?)"
fi
if ! grep -q '"t":"done"' "$BODY_FILE"; then
  fail "stream had no done event"
fi
if grep -q '"t":"error"' "$BODY_FILE"; then
  echo "stream errors:" >&2
  grep '"t":"error"' "$BODY_FILE" >&2
  fail "stream reported an error"
fi
if ! grep -q '"stdout"' "$BODY_FILE"; then
  fail "no tool output in the stream"
fi

echo "  stream events:"
grep -o '"t":"[a-z_]*"' "$BODY_FILE" | sort | uniq -c | sed 's/^/    /'

echo "PASS"
