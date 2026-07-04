#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

backend_url="${ROBOT_BACKEND_URL:-http://127.0.0.1:3100/health_check}"

not_running="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' \
	| awk '$2 != "running" || ($3 != "" && $3 != "healthy") { print $1"="$2($3=="" ? "" : "/"$3) }')"

if [ -n "$not_running" ]; then
	echo "containers unhealthy: $(echo "$not_running" | paste -sd, -)"
	exit 1
fi

if ! backend="$(curl -fsS --max-time 10 "$backend_url" 2>&1)"; then
	echo "backend health_check unreachable at $backend_url"
	exit 1
fi

if ! echo "$backend" | grep -q '"status":"ok"'; then
	echo "backend health_check did not return ok: $backend"
	exit 1
fi

running_count="$(docker compose ps --format '{{.Service}}' | grep -c .)"
echo "containers Up ($running_count) and backend returned ok"
exit 0
