#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HEALTH_MONITOR_ENV:-$HOME/.envs/robot-mill/health-monitor.env}"
SESSION="robot-mill-health"
LOG_DIR="$HOME/robot-mill/logs"
LOG="$LOG_DIR/health-monitor.log"

ENV_ARG=""
[ -f "$ENV_FILE" ] && ENV_ARG="--env-file=$ENV_FILE"

mkdir -p "$LOG_DIR"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$RUNNER_DIR" \
	"while true; do echo \"[start] \$(date -Is)\"; $HOME/.bun/bin/bun run $ENV_ARG src/index.ts; echo \"[exited \$?] \$(date -Is); restarting in 3s\"; sleep 3; done 2>&1 | tee -a '$LOG'"

echo "health-monitor started in tmux session '$SESSION' (auto-restart, logging to $LOG)"
echo "  logs:   tail -f $LOG   |   tmux attach -t $SESSION"
echo "  status: curl http://127.0.0.1:3300/  |  /health (json)"
