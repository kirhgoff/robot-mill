# robot-mill

Runs on peeper. Deploy/env details: `DEPLOYMENT_NOTES.md`.

- Deploy from another machine: `fish scripts/deploy-remote.fish [--telegram] [branch]` (refuses to run on peeper).
- Restart a host component (tmux service): `scripts/start-host.sh <component>` (`host-runner`, `linear-connector`, `health-monitor`).
- Component env files on peeper: `~/.envs/robot-mill/<component>.env` (`ALLOWED_PROJECTS` lives in `host-runner.env`); compose `.env` -> `~/.envs/robot-mill/.env`.
- Checks: `mise run check` runs everything (tsc, tests, knip, shellcheck, hadolint, typos, betterleaks, actionlint, zizmor, agnix); CI runs the same. `mise run setup` installs dependencies and git hooks.
- robot-mill is LAN-only and trusted: reviews and plans cover reliability, correctness and ops, without auth, CORS or privilege-hardening suggestions.
