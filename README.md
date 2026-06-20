# Pi Agent Docker — Telegram Bridge

Runs the [pi coding agent](https://github.com/badlogic/pi-mono) in a container
and exposes it via a Telegram bot. Send prompts from anywhere on your Tailscale
network; pi does the work inside the container.

## Architecture

```
Telegram ──► bot.js ──► pi --mode rpc (JSONL over stdin/stdout) ──► your repos
```

`bot.js` spawns `pi` in **RPC mode** — a stable JSONL protocol over stdin/stdout.
One pi process per Telegram chat keeps context alive across messages.

## Directory layout

```
programming/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── install/
│   ├── 00-base.sh        system packages, locale
│   ├── 10-node.sh        Node.js 22 LTS + pi agent (global)
│   ├── 20-mise.sh        mise — per-project language versions
│   ├── 30-github.sh      GitHub CLI (gh)
│   ├── 40-user-setup.sh  'agent' user, workspace, SSH dir
│   └── 50-entrypoint.sh  writes /home/agent/entrypoint.sh
└── bot/
    ├── bot.js            Telegram ↔ pi RPC bridge
    └── package.json      telegraf dependency
```

## Local development

Run the backend and web frontend locally without Docker.

### Backend (`robot-fastify-backend`)

**Prerequisites:** [Bun](https://bun.sh) installed.

```bash
cd robot-fastify-backend

# Install dependencies (if not done yet)
bun install

# Set your Anthropic API key
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local

# Start dev server (auto-reloads on file changes)
bun run dev
```

The server starts at **`http://127.0.0.1:3100`**. Verify with:

```bash
curl http://localhost:3100/health_check
```

> Sessions and workspace are stored in `.data/` (git-ignored).

### Web frontend (`web-variations-frontend`)

```bash
cd web-variations-frontend

# Install dependencies (if not done yet)
bun install

# Start Vite dev server
bun run dev
```

Vite will print the local URL (typically **`http://localhost:5173`**).

> Start the backend first so it's ready when the frontend connects.

---

## Quick start

### 1. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS
```

### 2. GitHub authentication (choose one)

**Option A — SSH key (recommended for private repos)**
```bash
mkdir -p secrets
cp ~/.ssh/your_deploy_key secrets/github_ssh_key
chmod 600 secrets/github_ssh_key
```

**Option B — HTTPS token**
```
# Set GITHUB_TOKEN in .env; remove the secrets block from docker-compose.yml
```

If you only use public repos, skip this step and remove the `secrets:` block from
`docker-compose.yml`.

### 3. Build & run

```bash
docker compose up --build -d
docker compose logs -f
```

### 4. Talk to your agent

Open Telegram, find your bot, and:

```
/start                        — start a pi session
/repo kirhgoff/blakablaka     — clone repo and work in it
/repo kirhgoff/note-ninja-nextjs
/repo kirhgoff/vary-workshop
/repo kirhgoff/robot-mill

Hey pi, what files are in the current directory?
Write tests for the auth module.
Fix the failing CI test in src/api.ts.
```

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Start a new pi session (kills any existing one) |
| `/stop` | End the session |
| `/new` | Fresh conversation, same pi process (resets context) |
| `/abort` | Abort the current pi operation |
| `/status` | Show session state |
| `/repo <url\|user/name>` | Clone repo (if needed) and switch session into it |

Any other message is forwarded to pi as a prompt.

## Per-project language versions

pi uses `mise` to manage runtimes. If a cloned repo contains a `.mise.toml` or
`.tool-versions` file, pi will detect and install the right Node / Python / Ruby /
Go / etc. version automatically when you ask it to work on the project.

## Customising pi

Drop extensions, skills, or prompt templates into the `pi-home` Docker volume
(`/home/agent/.pi/agent/`) to customise pi's behaviour across all sessions.

## Security notes

- Set `ALLOWED_CHAT_IDS` to your own Telegram chat ID.
- The `agent` user has `NOPASSWD` sudo inside the container — treat the container
  as a trusted workload and don't expose any ports.
- Use Docker secrets or a proper secrets manager for API keys in production.
