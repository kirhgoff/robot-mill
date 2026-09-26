# Robot Mill

Runs the [pi coding agent](https://github.com/badlogic/pi-mono) against your real
repos, driven from Telegram or from Linear. One runtime spawns every agent: the
**host-runner**. Nothing else spawns agents.

## Architecture

```
Linear (Agent Queue) ──► linear-connector ──► host-runner ──► tmux `pi-<key>` ──► your repos
Telegram              ──► telegram-frontend ──┘
                                                    │
                                     robot-fastify-backend (console + aggregator)
```

- **`host-runner`** — runs directly on the host under `bun`. Every pi agent runs
  here, each in its own tmux session named `pi-<key>`, with full host access
  (files, `docker compose`, scripts). Nothing else runs pi.
- **`linear-connector`** — the single entry point for autonomous work. Polls a
  Linear team's states, dispatches queued issues to the host-runner, tracks them
  to completion, and pushes its own Telegram notifications.
- **`telegram-frontend`** — Telegraf bot (containerized). Routes a chat to a host
  project (`/project`), files Linear tickets (`/ticket`, `/ops`), and shows what's
  running (`/agents`).
- **`health-monitor`** — scheduled deterministic health checks of other host
  projects, with a low-cost model escalation on failure and its own Telegram
  notifications.
- **`robot-fastify-backend`** — containerized. Serves the web console + homepage
  and aggregates/proxies the host-runner, health-monitor and linear-connector for
  it. Its `AgentManager`/`/agents`/`/ws` code is retained only because the
  variation-manager and its tests need it — nothing user-facing talks to it, and
  Telegram never does. The variation-manager itself is gated behind
  `VARIATIONS_ENABLED` (default off: not constructed, no routes, no port range).
- **`web-variations-frontend`** — the variation-manager's UI. Only relevant when
  `VARIATIONS_ENABLED=true`.

## Repository layout

```
robot-mill/
├── Dockerfile                 single image for backend + telegram (shared entrypoint)
├── docker-compose.yml         backend + telegram (behind the `telegram` profile)
├── .env.example
├── install/                   image build steps
├── robot-fastify-backend/     console + aggregator (containerized, /workspace)
├── telegram-frontend/         Telegram bot (containerized)
├── host-runner/                pi agents in host tmux sessions on real projects
├── linear-connector/           dispatches Linear issues to host-runner tasks
├── health-monitor/             scheduled host-project health checks
├── web-console/                homepage + robot-mill console (served at / and /console)
├── web-variations-frontend/    variation-manager UI (VARIATIONS_ENABLED only)
├── scripts/                    start-host.sh, boot.sh, rolling-log.ts, deploy-remote.fish
└── DEPLOYMENT_NOTES.md
```

## Where agents run

| Key (tmux `pi-<key>`) | cwd | Created by | Purpose |
|---|---|---|---|
| `<project>` | `~/Projects/<project>` | Telegram `/project` chat, console prompt box; health-monitor diagnosis uses a throwaway `diag-*` key | interactive |
| `<project>-<issue>`, e.g. `nightcrawler-kir-123` | `~/robot-mill/worktrees/<project>/kir-123` | linear-connector, a code ticket | worktree → branch → PR |
| `<project>-<issue>` | `~/Projects/<project>` (main checkout) | linear-connector, a ticket labelled `ops` | runbook/deploy, no PR |

A worktree is created from the repo's default branch, on a branch named after
the issue identifier (e.g. `kir-123`); the host-runner symlinks anything in the
main checkout's top level that is itself a symlink (`.env`, `data`, …) into it,
but does **not** install dependencies — the agent's own prompt tells it to run
`bun install` / `npm ci` first.

Visibility: `tmux attach -t pi-<key>` to watch/steer any session directly, the
console's live stream, or Telegram `/agents`.

## Linear workflow

Linear is the single entry point for ticket-driven work. Move an issue to
**Agent Queue** (or file one from Telegram with `/ticket` or `/ops`) and the
connector takes it from there.

**States** (env-overridable, auto-created where noted):

| State | Meaning |
|---|---|
| `Agent Queue` (auto-created) | waiting to be picked up |
| `In Progress` | an agent is running |
| `In Review` | code ticket finished — PR opened |
| `Done` | ops ticket finished |
| `Agent Failed` (auto-created) | failed; move back to `Agent Queue` to retry |

**Labels** (auto-created): `agent` — added to every ticket the connector picks
up. `ops` — marks the ticket as a runbook/deploy task instead of a code change.

**Resolving the target repo:** the issue's Linear *project* name, or a label,
must match one of the host-runner's `ALLOWED_PROJECTS`. No match → a comment
asking for one, then `Agent Failed`.

**Flow:**

1. `Agent Queue` → label `agent`, comment `🤖 started in <project> (<mode>) ·
   tmux attach -t pi-<key>`, move to `In Progress`, `POST /task` to the
   host-runner.
2. **Code ticket:** the agent works in a dedicated git worktree, is asked to
   commit, push the branch and open a pull request via the GitHub REST API
   (`gh` is not installed in the host-runner's environment — the agent uses
   `$GITHUB_TOKEN` directly). On success the connector looks up the PR by
   branch, comments its URL, and moves the issue to `In Review`.
3. **Ops ticket** (label `ops`): the agent works in the project's main checkout
   on the host, follows that project's `AGENTS.md` runbook, and must not create
   branches or PRs. On success the connector comments the agent's summary and
   moves the issue to `Done`.
4. **Any failure** (agent process exited, timed out — default `TASK_TIMEOUT_MS`
   2h — or the host-runner request itself failed) → comment `❌ <reason>` and
   move to `Agent Failed`.
5. After every finalize: the host-runner task is torn down (tmux session
   killed, worktree removed — the pushed branch is kept — status file deleted) and a
   Telegram notification is sent.
6. **On connector restart:** any issue still `In Progress` and labelled `agent`
   is re-tracked from where it left off, rather than abandoned.

**Plan → execute:** when `PLAN_MODEL` is set, step 1 dispatches a planning
prompt on `PLAN_MODEL` instead of working the ticket directly. Once the plan
comes back, the connector posts it as a comment, notifies Telegram, and sends
a follow-up prompt to the *same* session telling it to execute the plan — pi's
`set_model` switches the session to `EXEC_MODEL` first, keeping the plan in
context. With `PLAN_MODEL` unset, the flow is single-phase exactly as above.

Notifications (start / success / failure) are pushed directly to Telegram by
the linear-connector and, separately, by the health-monitor — each holds its
own bot token + chat id.

## Telegram commands

Any message that isn't a command is forwarded to the chat's current project as
a prompt.

| Command | Description |
|---|---|
| `/project <name>` | Route this chat to a host project (plain text becomes a prompt to it) |
| `/ticket <project> <title>\n<description>` | File a Linear code ticket — the agent opens a PR |
| `/ops <project> <title>\n<description>` | File a Linear ops ticket — runbook, no PR |
| `/agents` | Running host projects + active Linear tasks, and this chat's current project |
| `/abort [KIR-123]` | Abort a Linear task by identifier, or this chat's project agent if none given |
| `/new` | Reset the conversation, keep the same pi process |
| `/stop` | Stop this chat's project agent |
| `/poll` | Poll Linear right now instead of waiting for the interval |

### Register with BotFather

```
project - Route this chat to a host project: /project <name>
ticket - File a Linear ticket for an agent: /ticket <project> <title>
ops - File an ops ticket (runbook, no PR): /ops <project> <title>
agents - Show running host projects + active Linear tasks
abort - Abort a Linear task or this chat's project agent
new - Fresh conversation in this chat's project
stop - Stop this chat's project agent
poll - Poll Linear now
```

## Web console + homepage

Served by the backend at the site root (`http://<host>/`) and
`http://<host>:3100/console`, with three title tabs: **poop house** (a
dashboard of media-streaming service links), **robot mill** (host runners with
a per-project prompt box, a tickets card listing active Linear tasks, and
system status), and **nightcrawler** (a landing page for the nightcrawler
search UI). The browser only talks to the backend; the backend aggregates and
proxies the host-runner, health-monitor and linear-connector.

## Components — env vars

### `host-runner` (host, tmux, port `3200`)

| Env var | Default | Purpose |
|---|---|---|
| `HOST_RUNNER_HOST` | `0.0.0.0` | listen address |
| `HOST_RUNNER_PORT` | `3200` | listen port |
| `PROJECTS_DIR` | `~/Projects` | where main checkouts live |
| `STATE_DIR` | `~/robot-mill/host-runner` | session/status state |
| `WORKTREES_DIR` | `~/robot-mill/worktrees` | where Linear code-ticket worktrees are created |
| `SESSION_MAX_AGE_MS` | 24h | a session file older than this is dropped before reuse (fresh pi conversation) |
| `ALLOWED_PROJECTS` | (any dir under `PROJECTS_DIR`) | comma-separated allow-list; also what Linear project names/labels resolve against |
| `PI_PROVIDER` | `openrouter` | `anthropic` \| `openrouter` \| `openai` |
| `PI_MODEL` | — | model slug for interactive/ticket agents |
| `SERVICE_PI_PROVIDER` | `PI_PROVIDER` | provider for the low-cost diagnose model |
| `SERVICE_PI_MODEL` | `anthropic/claude-haiku-4.5` | health-monitor diagnose model |
| provider key (`ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`) | — | required for the selected `PI_PROVIDER`; per-project override `<KEY>_<PROJECT>`, service override `<KEY>_SERVICE` |
| `GITHUB_TOKEN` | — | used by ticket agents to open PRs via the GitHub REST API |

`PI_PROVIDER=openai` is a supported setup: set `OPENAI_API_KEY` (per-project
override `OPENAI_API_KEY_<PROJECT>` works the same as the OpenRouter variant).

`POST /projects/:project/task` also accepts optional `model`/`provider` body
fields — when `model` is set, the session switches model (keeping its history)
before the prompt is sent.

### `linear-connector` (host, tmux, port `3400`)

| Env var | Default | Purpose |
|---|---|---|
| `LINEAR_API_KEY` | — | required |
| `LINEAR_TEAM_KEY` | `KIR` | Linear team |
| `LINEAR_TRIGGER_STATE` | `Agent Queue` | auto-created |
| `LINEAR_IN_PROGRESS_STATE` | `In Progress` | |
| `LINEAR_REVIEW_STATE` | `In Review` | |
| `LINEAR_DONE_STATE` | `Done` | |
| `LINEAR_FAILED_STATE` | `Agent Failed` | auto-created |
| `LINEAR_AGENT_LABEL` | `agent` | auto-created |
| `LINEAR_OPS_LABEL` | `ops` | |
| `HOST_RUNNER_URL` | `http://127.0.0.1:3200` | |
| `POLL_INTERVAL_MS` | 1h | how often to scan `Agent Queue` |
| `TICK_MS` | 30s | how often to check active tasks' status |
| `TASK_TIMEOUT_MS` | 2h | abort + fail a task that runs longer than this |
| `MAX_CONCURRENT_TASKS` | `3` | |
| `LINEAR_CONNECTOR_PORT` | `3400` | its own HTTP API (`/tasks`, `/poll`, `/tickets`, `/tasks/:id/abort`) |
| `GITHUB_TOKEN` | — | used to look up a ticket's PR by branch |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | optional; notifications off if either is unset |
| `PLAN_MODEL` | — | when set, dispatch a planning pass with this model before executing |
| `EXEC_MODEL` | — | model for the execute step (or the only step, if `PLAN_MODEL` is unset) |
| `MODEL_PROVIDER` | — | provider for `PLAN_MODEL`/`EXEC_MODEL`; empty uses the host-runner's `PI_PROVIDER` |

### `health-monitor` (host, tmux, port `3300`)

| Env var | Default | Purpose |
|---|---|---|
| `HOST_RUNNER_URL` | `http://127.0.0.1:3200` | used for the diagnose escalation |
| `PROJECTS_DIR` | `~/Projects` | |
| `HEALTH_PORT` | `3300` | |
| `SERVICE_PROJECTS` | `media-streaming,robot-mill,nightcrawler` | projects checked on a schedule |
| `CHECK_INTERVAL_MS` | 24h | |
| `CHECK_TIMEOUT_MS` | 2min | per-check subprocess timeout |
| `DIAGNOSE_ON_FAILURE` | `true` | escalate a failing check to the service model |
| `DIAGNOSE_TIMEOUT_MS` | 5min | |
| `PI_PROVIDER` / `PI_MODEL` | `openrouter` / — | diagnose model; provider key resolved the same way as host-runner's service key (`<KEY>_SERVICE` override) |
| `MIN_CREDITS_USD` | `10` | low-balance threshold for the `openrouter` check |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | optional; notifications off if either is unset |

Each check is deterministic (no model tokens) unless it fails: `<service
project>` runs the project's `scripts/health-check.sh` if present, else falls
back to `docker compose ps` parsing; `openrouter` hits the OpenRouter
`/credits` and `/models` endpoints. On failure the monitor escalates once, in a
fresh throwaway host-runner session, to the low-cost `SERVICE_PI_MODEL`, which
investigates, attempts a safe fix, and reports a `HEALTH: OK`/`HEALTH: FAIL`
verdict. Telegram is notified on the transition into failure and, separately,
on recovery — not on the interim "diagnosing…" step. Status: `http://127.0.0.1:3300/`
(text) and `/health` (JSON).

### `telegram-frontend` (container)

| Env var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `ALLOWED_CHAT_IDS` | (any) | comma-separated; empty allows everyone (dev only) |
| `HOST_RUNNER_URL` | `http://host.docker.internal:3200` | |
| `HOST_RUNNER_WS_URL` | `ws://host.docker.internal:3200/ws` | streams a project agent's output back to its chat |
| `LINEAR_URL` | `http://host.docker.internal:3400` | |
| `STATE_FILE` | `/data/telegram/state.json` | persists each chat's current project across restarts |

### `robot-fastify-backend` (container, port `3100`)

| Env var | Default | Purpose |
|---|---|---|
| `PI_PROVIDER` / `PI_MODEL` | `anthropic` / — | AI provider config |
| `HOST_RUNNER_URL` | `http://host.docker.internal:3200` | for the console's aggregation/proxy |
| `HEALTH_URL` | `http://host.docker.internal:3300` | |
| `LINEAR_URL` | `http://host.docker.internal:3400` | for the console's tickets card |
| `VARIATIONS_ENABLED` | `false` | construct the variation-manager and its routes |
| `LOG_LEVEL` | `info` | |

## Running the host components

`host-runner`, `linear-connector` and `health-monitor` are host-native tmux
processes (not containers) — they need real host access (tmux, `docker
compose`, other projects' checkouts).

Start one:

```sh
scripts/start-host.sh host-runner
scripts/start-host.sh linear-connector
scripts/start-host.sh health-monitor
```

Each reads its secrets from `~/.envs/robot-mill/<component>.env` (required for
`host-runner` and `linear-connector`; optional for `health-monitor`), runs
under tmux session `robot-mill-<component>` with auto-restart, and pipes its
output through `scripts/rolling-log.ts` into
`~/robot-mill/logs/<component>-YYYY-MM-DD.log` (also echoed live to the tmux
pane). Logs older than `LOG_KEEP_DAYS` (default `14`) are pruned at start and
on every date change.

Start all three and register them to come back on reboot:

```sh
scripts/boot.sh
```

`scripts/boot.sh` is what the crontab `@reboot` entry runs (installed
idempotently by `scripts/deploy-remote.fish`).

## Deploy to peeper

```fish
./scripts/deploy-remote.fish --telegram        # ff-pull origin/main, rebuild, restart
./scripts/deploy-remote.fish --telegram <branch>
```

Pulls the branch, rebuilds and restarts the `backend` (+ `telegram` if
`--telegram`) containers, restarts the three host components via
`scripts/start-host.sh`, (re)installs the `@reboot scripts/boot.sh` crontab
entry, and health-checks ports `3100`/`3200`/`3300`/`3400`. Targets the `peeper`
SSH alias by default; override with `ROBOT_MILL_SSH=<host>` if it's
unreachable (e.g. off the home LAN — see `DEPLOYMENT_NOTES.md`).

`.env` is gitignored and lives only on the remote — the deploy script never
touches it.

**Firewall note:** the host components are raw host processes (not
docker-published ports), so the containers reaching them via
`host.docker.internal` is subject to `ufw`:

```sh
sudo ufw allow from 172.16.0.0/12 to any port 3200:3400 proto tcp
```

## Ops runbooks

An `ops`-labelled Linear ticket runs the agent in the project's main checkout
and expects it to follow that project's own `AGENTS.md` for how to run its
maintenance/deploy tasks — the connector prompt just points it there and tells
it not to touch branches or PRs.

## Local development

```bash
cd robot-fastify-backend && bun install && bun run dev   # http://127.0.0.1:3100
cd telegram-frontend && bun install && bun run dev
cd host-runner && bun install && bun run start            # http://127.0.0.1:3200
cd linear-connector && bun install && bun run start
cd health-monitor && bun install && bun run start         # http://127.0.0.1:3300
```

Type-check and test:

```bash
cd robot-fastify-backend && bun run check && bun test
cd host-runner && bunx tsc --noEmit
cd linear-connector && bunx tsc --noEmit
cd telegram-frontend && bunx tsc --noEmit
cd health-monitor && bunx tsc --noEmit
```

## Per-project language versions

pi uses `mise`. If a cloned repo has a `.mise.toml` or `.tool-versions`, pi
installs the right Node / Python / Ruby / Go version when it works on that
project.

## Customising pi

Drop extensions, skills, or prompt templates into the `pi-home` volume
(`/home/agent/.pi/agent/`) to customise pi across all sessions.
