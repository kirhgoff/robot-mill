#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${LINEAR_CONNECTOR_ENV:-$HOME/robot-mill/linear-connector.env}"
SESSION="robot-mill-linear"

if [ ! -f "$ENV_FILE" ]; then
	echo "Missing env file: $ENV_FILE" >&2
	exit 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$RUNNER_DIR" \
	"exec $HOME/.bun/bin/bun run --env-file=$ENV_FILE src/index.ts"

echo "linear-connector started in tmux session '$SESSION'"
echo "  logs: tmux attach -t $SESSION"
