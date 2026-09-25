# Deployment notes

Remote host: SSH alias `peeper` (`~/.ssh/config`), repo at
`/home/kirhgoff/Projects/robot-mill`. Override the target with
`ROBOT_MILL_SSH=<host>` (e.g. when `peeper` isn't reachable directly and you're
routing through Tailscale instead).

## What runs where

- Docker Compose runs `backend` (port `3100`) and, behind the `telegram`
  profile, `telegram`.
- Three host-native tmux processes, started by `scripts/start-host.sh` /
  `scripts/boot.sh` (not Compose services): `host-runner` (`3200`),
  `linear-connector` (`3400`), `health-monitor` (`3300`).

## Data layout (peeper convention)

Mutable data lives in `/home/kirhgoff/robot-mill/` (home root):
`workspace/`, `pi-home/`, `agent-sessions/`, `target/`, `telegram/`. The repo
symlinks `data -> /home/kirhgoff/robot-mill`; Compose bind-mounts `./data/*`
into the containers. These dirs are `chmod 777` so the container `agent` user
(uid 1001) can write.

**Secrets convention:** all per-project secret files live under
`~/.envs/<project>/`, and each project symlinks them from its repo, e.g.
`~/Projects/robot-mill/.env -> ~/.envs/robot-mill/.env`. robot-mill's host
components each read their own env file:

- `~/.envs/robot-mill/host-runner.env`
- `~/.envs/robot-mill/linear-connector.env`
- `~/.envs/robot-mill/health-monitor.env`

`host-runner.env` and `linear-connector.env` are required (their `start-host.sh`
invocation refuses to start without one); `health-monitor.env` is optional —
without it the `openrouter` check degrades to `unknown` and Telegram
notifications stay off.

## Redeploy

```fish
./scripts/deploy-remote.fish --telegram          # main branch
./scripts/deploy-remote.fish --telegram <branch>
```

This pulls the branch, `docker compose up --build -d`s the containers,
restarts all three host components via `scripts/start-host.sh`, (re)installs
an idempotent `@reboot scripts/boot.sh` crontab entry, and health-checks ports
`3100`, `3200`, `3300`, `3400` with a few retries each.

`.env` is gitignored and is NOT managed by the deploy script — set secrets
directly on the remote; they persist across deploys.

Manual remote check:

```fish
ssh peeper 'cd /home/kirhgoff/Projects/robot-mill; docker compose ps; docker compose logs --tail=100 backend telegram'
ssh peeper 'tmux ls; tail -n 100 ~/robot-mill/logs/linear-connector-$(date +%F).log'
```

## Host components after a reboot

`scripts/boot.sh` is the crontab `@reboot` entry; it starts all three host
components via `scripts/start-host.sh`. Each component's own tmux session
(`robot-mill-<component>`) auto-restarts its process on crash (10s backoff) —
the crontab entry only needs to fire once per boot.

Logs: `~/robot-mill/logs/<component>-YYYY-MM-DD.log`, rotated daily by
`scripts/rolling-log.ts` (kept `LOG_KEEP_DAYS`, default `14`, days; also
echoed live to the tmux pane).

Git worktrees for Linear code tickets live at `~/robot-mill/worktrees/<project>/<issue>`
and are removed by the connector once a ticket finalizes.

## AI provider

- `PI_PROVIDER=openrouter` with `PI_MODEL=anthropic/claude-opus-4.8` routes
  through OpenRouter; `pi` inherits its container/host process's env, so any
  key added there reaches the agent.
- Per-key cost attribution: any unset key falls back to the shared
  `OPENROUTER_API_KEY` (or the `ANTHROPIC_`/`OPENAI_` equivalent), so nothing
  breaks if a split key is absent.
  - `OPENROUTER_API_KEY_BACKEND` — the backend container's agents → compose
    `.env`.
  - `OPENROUTER_API_KEY_<PROJECT>` — host-runner agents for that repo (both
    interactive `/project` and Linear tasks), named by uppercased repo with
    non-alphanumerics as `_` (e.g. `media-streaming` →
    `OPENROUTER_API_KEY_MEDIA_STREAMING`) → `host-runner.env`.
  - `OPENROUTER_API_KEY_SERVICE` — the low-cost diagnose model
    (`SERVICE_PI_MODEL`, default `anthropic/claude-haiku-4.5`) → both
    `host-runner.env` and `health-monitor.env`.

## Linear setup

1. Create/point an API key at the team in `LINEAR_TEAM_KEY` (default `KIR`);
   put it in `linear-connector.env` as `LINEAR_API_KEY`.
2. States `Agent Queue` and `Agent Failed`, and label `agent`, are
   auto-created on first connect if missing. `In Progress`/`In Review`/`Done`
   must already exist in the team's workflow.
3. Label a project (or add a project-matching Linear project name) with a
   name from `host-runner`'s `ALLOWED_PROJECTS` so the connector can resolve a
   target repo. Add the `ops` label to a ticket to run it as a runbook/deploy
   task instead of a code change.
4. `GITHUB_TOKEN` in `linear-connector.env` is used to look up a ticket's PR by
   branch; the same token (in `host-runner.env`) is what the agent itself uses
   to open the PR via the GitHub REST API (`gh` is not installed on the host
   for agents to use).

## Telegram bot setup

1. Create a bot with `@BotFather`, put its token in `.env` as
   `TELEGRAM_BOT_TOKEN` (containerized bot) — and, separately, in
   `linear-connector.env` and `health-monitor.env` if you want their own
   notifications (each holds its own token + `TELEGRAM_CHAT_ID`).
2. Get your chat id (`@userinfobot`) and set `ALLOWED_CHAT_IDS` in `.env`
   (empty allows everyone — dev only) and `TELEGRAM_CHAT_ID` wherever a
   component should notify.
3. Paste the command list from `README.md`'s "Register with BotFather"
   section into `/setcommands`.
4. Deploy with the `telegram` profile enabled: `./scripts/deploy-remote.fish --telegram`.

## Firewall

The host components are raw host processes (not Docker-published ports), so
the containers reaching them via `host.docker.internal` is subject to `ufw`:

```sh
sudo ufw allow from 172.16.0.0/12 to any port 3200:3400 proto tcp
```

This covers `host-runner` (`3200`) through `linear-connector` (`3400`). The
host components themselves reach each other over loopback, so they need no
firewall change.

## Notes

- The container entrypoint runs the Compose `command:` for each service
  (`install/50-entrypoint.sh`).
- The pi home dir (`/home/agent/.pi`, bind-mounted from `data/pi-home`) must be
  writable by `agent` (uid 1001) or `pi` fails with `EACCES`; the deploy
  script `chmod 777`s the data dirs.
