#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

for component in host-runner linear-connector health-monitor; do
	scripts/start-host.sh "$component"
done
