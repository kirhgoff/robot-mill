#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HEALTH_MONITOR_ENV:-$HOME/.envs/robot-mill/health-monitor.env}"
SESSION="robot-mill-health"

ENV_ARG=""
[ -f "$ENV_FILE" ] && ENV_ARG="--env-file=$ENV_FILE"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$RUNNER_DIR" \
	"exec $HOME/.bun/bin/bun run $ENV_ARG src/index.ts"

echo "health-monitor started in tmux session '$SESSION'"
echo "  logs:   tmux attach -t $SESSION"
echo "  status: curl http://127.0.0.1:3300/  |  /health (json)"
