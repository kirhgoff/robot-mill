# robot-mill

Runs on peeper. Deploy/env details: `DEPLOYMENT_NOTES.md`.

- Deploy from another machine: `fish scripts/deploy-remote.fish [--telegram] [branch]` (refuses to run on peeper).
- Restart a host component (tmux service): `scripts/start-host.sh <component>` (`host-runner`, `linear-connector`, `health-monitor`), not `host-runner/start.sh`.
- Component env files on peeper: `~/.envs/robot-mill/<component>.env` (`ALLOWED_PROJECTS` lives in `host-runner.env`); compose `.env` -> `~/.envs/robot-mill/.env`.
- Per component: `bun run check && bun test`. CI runs the same.
