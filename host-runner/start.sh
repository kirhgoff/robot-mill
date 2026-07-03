#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HOST_RUNNER_ENV:-$HOME/.envs/robot-mill/host-runner.env}"
SESSION="robot-mill-host-runner"
LOG_DIR="$HOME/robot-mill/logs"
LOG="$LOG_DIR/host-runner.log"

if [ ! -f "$ENV_FILE" ]; then
	echo "Missing env file: $ENV_FILE" >&2
	exit 1
fi

mkdir -p "$LOG_DIR"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$RUNNER_DIR" \
	"while true; do echo \"[start] \$(date -Is)\"; $HOME/.bun/bin/bun run --env-file=$ENV_FILE src/index.ts; echo \"[exited \$?] \$(date -Is); restarting in 3s\"; sleep 3; done 2>&1 | tee -a '$LOG'"

echo "host-runner started in tmux session '$SESSION' (auto-restart, logging to $LOG)"
echo "  logs:   tail -f $LOG   |   tmux attach -t $SESSION"
echo "  agents: tmux attach -t pi-<project>"
