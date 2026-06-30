# Deployment notes

Remote host: `kirhgoff@192.168.0.31`
Remote name: `peeper`
Remote repo: `/home/kirhgoff/Projects/robot-mill`

Current deployment:

- Repository cloned to `/home/kirhgoff/Projects/robot-mill`.
- Docker Compose started `backend` on `3100` and `web` on `3000`.
- Health check: `http://192.168.0.31:3100/health_check`.
- Web UI: `http://192.168.0.31:3000`.
- Remote `.env` currently has placeholder secrets. Replace `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`, and `GITHUB_TOKEN` before using the agent for real work.

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
ssh kirhgoff@192.168.0.31 'cd /home/kirhgoff/Projects/robot-mill; docker compose ps; docker compose logs --tail=100 backend web'
```

Telegram bot setup:

1. Create a bot with `@BotFather` and put its token in remote `.env` as `TELEGRAM_BOT_TOKEN`.
2. Get your Telegram chat id from `@userinfobot` and put it in `ALLOWED_CHAT_IDS`.
3. Put a real `ANTHROPIC_API_KEY` in remote `.env`.
4. Enable the `telegram` service in `docker-compose.yml`.
5. Redeploy.
6. Send `/start` to the bot, then send normal prompts.
