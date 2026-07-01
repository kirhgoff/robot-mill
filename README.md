# Robot Mill

Runs the [pi coding agent](https://github.com/badlogic/pi-mono) in a container and
drives it remotely over Telegram. Send prompts from your phone; pi does the work
inside the container against your repos.

## Architecture

```
Telegram ──► telegram-frontend ──HTTP+WS──► robot-fastify-backend ──► pi --mode rpc ──► your repos
```

- **`robot-fastify-backend`** — Fastify server that spawns and supervises one `pi`
  process per session (RPC mode: JSONL over stdin/stdout), exposing them over a REST
  API and a `/ws` WebSocket that streams agent events.
- **`telegram-frontend`** — Telegraf bot. One pi session per chat; forwards your
  messages as prompts and streams pi's output back.
- **`web-variations-frontend`** — experimental React UI for the backend's variation
  manager. Currently **disabled** (commented out in `docker-compose.yml`); the
  backend code stays so it can be re-integrated later.

## Repository layout

```
robot-mill/
├── Dockerfile                 single image for backend + telegram (shared entrypoint)
├── docker-compose.yml         backend + telegram (behind `telegram` profile)
├── .env.example
├── install/                   image build steps
│   ├── 00-base.sh             system packages, locale
│   ├── 10-node.sh             Node.js 22 + pinned pi agent (global)
│   ├── 11-bun.sh              Bun
│   ├── 20-mise.sh             mise — per-project language versions
│   ├── 30-github.sh           GitHub CLI (gh)
│   ├── 40-user-setup.sh       'agent' user, workspace, SSH dir
│   └── 50-entrypoint.sh       writes /home/agent/entrypoint.sh (runs the compose command)
├── robot-fastify-backend/     agent orchestration server (containerized, /workspace)
├── telegram-frontend/         Telegram bot
├── host-runner/               pi agents in host tmux sessions on real projects
├── linear-connector/          dispatches Linear issues to agents
├── web-variations-frontend/   experimental UI (disabled)
├── scripts/deploy-remote.fish redeploy to the peeper box
└── DEPLOYMENT_NOTES.md
```

## AI provider

Set `PI_PROVIDER` and the matching key — startup validation only requires the key
for the selected provider:

| `PI_PROVIDER` | Key env var | `PI_MODEL` example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-4-8` |
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-opus-4.8`, `openai/gpt-4o` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |

OpenRouter serves both Claude and GPT models, so a single `OPENROUTER_API_KEY` covers
both with the `provider/id` model slug.

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env — set PI_PROVIDER + its key, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS,
# and GITHUB_TOKEN (needed for the agent to clone private repos and open PRs).

docker compose --profile telegram up --build -d
docker compose --profile telegram logs -f
```

Backend health:

```bash
curl http://localhost:3100/health_check   # {"status":"ok"}
```

To get your Telegram chat ID for `ALLOWED_CHAT_IDS`: message the bot, then
`curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and read `message.chat.id`.

## Deploy to peeper

```fish
./scripts/deploy-remote.fish --telegram        # ff-pull origin/main, rebuild, restart
./scripts/deploy-remote.fish --telegram <branch>
```

`.env` is gitignored and lives only on the remote — the deploy script never touches
it. See `DEPLOYMENT_NOTES.md` for the full remote setup.

## Bot commands

Any message that isn't a command is forwarded to the active agent as a prompt.
Each chat has one active target: the containerized workspace agent by default, or
a host project (`/project`) / cloned repo (`/repo`).

**Session control**

| Command | Description |
|---------|-------------|
| `/start` | Start a new workspace agent for this chat (kills any existing one) |
| `/stop` | End the chat's session |
| `/new` | Reset the conversation but keep the same pi process (clears context) |
| `/abort` | Abort the operation the agent is currently running |

**Choosing where the agent works**

| Command | Description |
|---------|-------------|
| `/project <name>` | Route this chat to a real host project via the host-runner (e.g. `/project media-streaming` — then "restart the sonarr container"). Full host access. |
| `/repo <owner/name>` | Clone a GitHub repo into the workspace and work in it (e.g. `/repo kirhgoff/eurotrip-support`). The agent can branch, commit, and open PRs. |
| `/local` | Switch back to the default containerized workspace agent |

**Info**

| Command | Description |
|---------|-------------|
| `/status` | Show this chat's session state (agent id, workdir) |
| `/system` | System-wide status: all running agents and what they're doing |

### Register with BotFather

Paste this into `@BotFather` → `/setcommands` so the commands appear in Telegram's
command menu:

```
start - Start a new workspace agent (kills current)
stop - End the session
new - Reset conversation, keep the process
abort - Abort the current operation
project - Work in a host project: /project <name>
repo - Clone and work in a repo: /repo <owner/name>
local - Back to the workspace agent
status - Show this chat's session state
system - System-wide status of all agents
```

## Host runner — agents on real host projects

The backend runs agents inside the container in an isolated `/workspace`. The
**host-runner** (runs directly on the host, under bun) instead runs one pi RPC
session per real project on the host, each inside a tmux session named
`pi-<project>`, with full host access (files, `docker compose`, scripts).

- Config: `~/robot-mill/host-runner.env` (`HOST_RUNNER_PORT`, `PROJECTS_DIR`,
  `ALLOWED_PROJECTS`, `PI_PROVIDER`, `PI_MODEL`, provider key, `GITHUB_TOKEN`).
- Start: `host-runner/start.sh` (launches tmux session `robot-mill-host-runner`).
- Drive from Telegram with `/project <name>`; observe/steer with
  `host-runner/attach.sh <project>` (i.e. `tmux attach -t pi-<project>`).
- Git auth is injected per-agent via `GIT_CONFIG_*` env (uses `GITHUB_TOKEN`
  without touching the host's `~/.gitconfig`).

**Firewall note:** the host-runner is a raw host process (not a docker-published
port), so the Telegram *container* reaching it via `host.docker.internal:3200` is
subject to `ufw`. Allow the docker bridge subnets once:

```sh
sudo ufw allow from 172.16.0.0/12 to any port 3200 proto tcp
```

(The linear-connector runs on the host and reaches the host-runner over loopback,
so it needs no firewall change.)

## Linear connector

Polls a Linear status column and dispatches issues to agents.

- Config: `~/robot-mill/linear-connector.env` (`LINEAR_API_KEY`, `LINEAR_TEAM_KEY`,
  `LINEAR_TRIGGER_STATE`, `HOST_RUNNER_URL`, …).
- Move an issue into the trigger column (default **"Agent Queue"**, auto-created)
  and label it with a target host project (e.g. `media-streaming`). The connector
  moves it to **In Progress**, runs the agent with the issue as its task, comments
  the result, and moves it to **In Review**.
- Start: `linear-connector/start.sh` (tmux session `robot-mill-linear`).

## Local development

```bash
# Backend (http://127.0.0.1:3100) — put keys in robot-fastify-backend/.env.local
cd robot-fastify-backend && bun install && bun run dev

# Telegram frontend (in another shell)
cd telegram-frontend && bun install && bun run dev
```

Type-check and test the backend:

```bash
cd robot-fastify-backend && bun run check && bun test
```

## Per-project language versions

pi uses `mise`. If a cloned repo has a `.mise.toml` or `.tool-versions`, pi installs
the right Node / Python / Ruby / Go version when it works on that project.

## Customising pi

Drop extensions, skills, or prompt templates into the `pi-home` volume
(`/home/agent/.pi/agent/`) to customise pi across all sessions.

## Security notes

- Set `ALLOWED_CHAT_IDS` to your own Telegram chat ID(s). Empty allows everyone —
  dev only.
- The `agent` user has `NOPASSWD` sudo inside the container — treat it as a trusted
  workload and don't expose its ports publicly.
- Use Docker secrets or a real secrets manager for API keys in production.
```
