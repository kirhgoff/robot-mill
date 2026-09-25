#!/usr/bin/env bash
set -euo pipefail

component="${1:?usage: start-host.sh <component>}"

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$REPO/$component"
ENV_FILE="$HOME/.envs/robot-mill/$component.env"
SESSION="robot-mill-$component"
LOG_DIR="$HOME/robot-mill/logs"

ENV_ARG=""
if [ -f "$ENV_FILE" ]; then
	ENV_ARG="--env-file=$ENV_FILE"
elif [ "$component" = "host-runner" ] || [ "$component" = "linear-connector" ]; then
	echo "Missing env file: $ENV_FILE" >&2
	exit 1
fi

mkdir -p "$LOG_DIR"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$DIR" \
	"while true; do echo \"[start] \$(date -Is)\"; $HOME/.bun/bin/bun run $ENV_ARG src/index.ts; echo \"[exited \$?] \$(date -Is); restarting in 10s\"; sleep 10; done 2>&1 | $HOME/.bun/bin/bun run $REPO/scripts/rolling-log.ts $LOG_DIR $component"

echo "$component started in tmux session '$SESSION'"
echo "  logs:   tail -f $LOG_DIR/$component-$(date +%F).log   |   tmux attach -t $SESSION"
