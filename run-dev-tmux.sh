#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="${1:-uncharted-dev}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${PROJECT_ROOT}/backend"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed. Install tmux and try again."
  exit 1
fi

if [ ! -d "${BACKEND_DIR}" ]; then
  echo "Backend directory not found at ${BACKEND_DIR}"
  exit 1
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Session '${SESSION_NAME}' already exists. Killing and recreating..."
  tmux kill-session -t "${SESSION_NAME}"
fi

tmux new-session -d -s "${SESSION_NAME}" -n backend
tmux send-keys -t "${SESSION_NAME}:backend" "cd \"${BACKEND_DIR}\" && uv sync && uv run uvicorn app.main:app --reload --port 8000" C-m

tmux new-window -t "${SESSION_NAME}" -n frontend
tmux send-keys -t "${SESSION_NAME}:frontend" "cd \"${PROJECT_ROOT}\" && npm run dev" C-m

tmux select-window -t "${SESSION_NAME}:frontend"
exec tmux attach -t "${SESSION_NAME}"
