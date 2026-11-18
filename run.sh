#!/usr/bin/env bash
# Load .env (if present) and start RepoScope with Spin.
#
#   cp .env.example .env
#   ./run.sh
#
# Extra arguments are passed to `spin up`, for example:
#   ./run.sh --listen 0.0.0.0
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v spin >/dev/null 2>&1; then
  echo "error: spin is not installed. See https://spinframework.dev" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Map the friendlier names from .env onto Spin's variable convention. An
# explicitly set SPIN_VARIABLE_* always wins over the convenience variable.
export SPIN_VARIABLE_OPENAI_API_KEY="${SPIN_VARIABLE_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
export SPIN_VARIABLE_OPENAI_BASE_URL="${SPIN_VARIABLE_OPENAI_BASE_URL:-${OPENAI_BASE_URL:-}}"
export SPIN_VARIABLE_MODEL="${SPIN_VARIABLE_MODEL:-${MODEL:-}}"
export SPIN_VARIABLE_ACCESS_TOKEN="${SPIN_VARIABLE_ACCESS_TOKEN:-${ACCESS_TOKEN:-}}"
export SPIN_VARIABLE_LOG_LEVEL="${SPIN_VARIABLE_LOG_LEVEL:-${LOG_LEVEL:-}}"
export SPIN_VARIABLE_MAX_TURNS="${SPIN_VARIABLE_MAX_TURNS:-${MAX_TURNS:-}}"

# Empty values would override the defaults in spin.toml, so drop them.
for name in \
  SPIN_VARIABLE_OPENAI_BASE_URL \
  SPIN_VARIABLE_MODEL \
  SPIN_VARIABLE_ACCESS_TOKEN \
  SPIN_VARIABLE_LOG_LEVEL \
  SPIN_VARIABLE_MAX_TURNS; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done

if [[ -z "${SPIN_VARIABLE_OPENAI_API_KEY:-}" ]]; then
  echo "warning: OPENAI_API_KEY is not set; /api/chat will return 503." >&2
  echo "         Copy .env.example to .env, or export SPIN_VARIABLE_OPENAI_API_KEY." >&2
fi

echo "Starting RepoScope (spin up --build; default http://127.0.0.1:3000)"
exec spin up --build "$@"
