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
├── robot-fastify-backend/     agent orchestration server
├── telegram-frontend/         Telegram bot
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

| Command | Description |
|---------|-------------|
| `/start` | Start a new pi session (kills any existing one) |
| `/stop` | End the session |
| `/new` | Fresh conversation, same pi process (resets context) |
| `/abort` | Abort the current pi operation |
| `/status` | Show this chat's session state |
| `/system` | System-wide status (all agents) |

Any other message is forwarded to pi as a prompt.

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
