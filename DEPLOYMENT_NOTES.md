# Deployment notes

Remote host: `kirhgoff@192.168.0.31`
Remote name: `peeper`
Remote repo: `/home/kirhgoff/Projects/robot-mill`

Current deployment:

- Repository at `/home/kirhgoff/Projects/robot-mill`.
- Docker Compose runs `backend` (port `3100`) and `telegram` (behind the `telegram` profile). The `web` service is disabled.
- Health check: `http://192.168.0.31:3100/health_check`.

Data layout (peeper convention):

- Mutable data lives in `/home/kirhgoff/robot-mill/` (home root): `workspace/`, `pi-home/`, `agent-sessions/`, `target/`. The repo symlinks `data -> /home/kirhgoff/robot-mill`; compose bind-mounts `./data/*` into the containers. These dirs are `chmod 777` so the container `agent` user (uid 1001) can write.
- **Secrets convention:** all per-project secret files live under `~/.envs/<project>/`, and each project symlinks them from its repo. E.g. `~/Projects/robot-mill/.env -> ~/.envs/robot-mill/.env`, `~/Projects/eurotrip-support/.env -> ~/.envs/eurotrip-support/.env` (likewise `media-streaming`, `nightcrawler`). Edit files under `~/.envs/<project>/` to change secrets; host-only.
- robot-mill's host components read `~/.envs/robot-mill/{host-runner,linear-connector,health-monitor}.env`.
- eurotrip-support's `bun run all` also needs Google OAuth files, symlinked from the repo to `~/.envs/eurotrip-support/{credentials.json,token.json,token.docs.json,token.calendar.json}`. Drop the real files (copied from a machine where the OAuth flow was completed — tokens can't be generated headlessly) into `~/.envs/eurotrip-support/` and the repo symlinks resolve.

Redeploy from another machine:

```fish
./scripts/deploy-remote.fish
```

Redeploy another branch:

```fish
./scripts/deploy-remote.fish branch-name
```

Manual remote check:

```fish
ssh kirhgoff@192.168.0.31 'cd /home/kirhgoff/Projects/robot-mill; docker compose --profile telegram ps; docker compose --profile telegram logs --tail=100 backend telegram'
```

Telegram bot setup:

1. Create a bot with `@BotFather` and put its token in remote `.env` as `TELEGRAM_BOT_TOKEN`.
2. Get your Telegram chat id and put it in `ALLOWED_CHAT_IDS` (empty allows everyone — dev only).
3. Set the provider key in remote `.env` matching `PI_PROVIDER` — startup validation only requires the selected provider's key (`anthropic`→`ANTHROPIC_API_KEY`, `openrouter`→`OPENROUTER_API_KEY`, `openai`→`OPENAI_API_KEY`).
4. The `telegram` service lives behind the `telegram` Compose profile — deploy with the flag below to start it.
5. Send `/start` to the bot, then send normal prompts.

AI provider:

- `PI_PROVIDER=openrouter` with `PI_MODEL=anthropic/claude-opus-4.8` routes through OpenRouter (key in `OPENROUTER_API_KEY`).
- `pi` inherits the backend container's env, so any provider key added to the backend `environment:` block reaches the agent.

Deploy with the Telegram service enabled (from another machine):

```fish
./scripts/deploy-remote.fish --telegram
```

Notes:

- The deploy script also restarts the host components (host-runner, health-monitor, linear-connector) in their tmux sessions, then health-checks both the backend (port `3100`) and host-runner (port `3200`).
- `.env` is gitignored and is NOT managed by the deploy script. Set secrets directly in the remote `.env`; they persist across deploys.
- The container entrypoint runs the Compose `command:` for each service (`install/50-entrypoint.sh`). It previously hijacked any service that had `TELEGRAM_BOT_TOKEN` set to run a removed `bot/bot.js`; that branch was removed.
- The pi home dir (`/home/agent/.pi`, bind-mounted from `data/pi-home`) must be writable by `agent` (uid 1001) or `pi` fails with `EACCES`; the deploy script `chmod 777`s the data dirs.
