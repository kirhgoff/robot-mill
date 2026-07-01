#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HOST_RUNNER_ENV:-$HOME/robot-mill/host-runner.env}"
SESSION="robot-mill-host-runner"

if [ ! -f "$ENV_FILE" ]; then
	echo "Missing env file: $ENV_FILE" >&2
	exit 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$RUNNER_DIR" \
	"exec $HOME/.bun/bin/bun run --env-file=$ENV_FILE src/index.ts"

echo "host-runner started in tmux session '$SESSION'"
echo "  logs:   tmux attach -t $SESSION"
echo "  agents: tmux attach -t pi-<project>"
