#!/usr/bin/env bash
# Open (or re-attach to) an INTERACTIVE pi session for a project — type directly.
# Separate from the automated pi-<project> RPC session used by the system.
set -euo pipefail

P="${1:?usage: pi-shell.sh <project>}"
DIR="$HOME/Projects/$P"
[ -d "$DIR" ] || { echo "no such project: $DIR" >&2; exit 1; }

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ENV_FILE="$HOME/robot-mill/host-runner.env"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

if [ -n "${GITHUB_TOKEN:-}" ]; then
	export GIT_CONFIG_COUNT=1
	export GIT_CONFIG_KEY_0="url.https://${GITHUB_TOKEN}@github.com/.insteadOf"
	export GIT_CONFIG_VALUE_0="https://github.com/"
fi

SESS="$HOME/robot-mill/host-runner/sessions/shell-$P.json"
MODEL_ARG=""
[ -n "${PI_MODEL:-}" ] && MODEL_ARG="--model $PI_MODEL"

exec tmux new-session -A -s "pi-shell-$P" -c "$DIR" \
	"pi --provider ${PI_PROVIDER:-openrouter} $MODEL_ARG --session $SESS"
