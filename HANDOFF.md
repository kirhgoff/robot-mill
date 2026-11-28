# Robot mill: implementation brief

Rewrite robot-mill as a self-hosted agent farm on `mimi.local` (macOS). Kirill sends a request on Telegram, or moves a Linear ticket to **Agent Queue**. The farm files the ticket, a worker agent builds it in its own worktree and opens a PR, a reviewer agent reviews it, and the builder fixes the findings. Kirill is contacted only for questions, failures, plan limits and "PR ready for you". The farm never merges.

The old code is obsolete. Delete it, and copy a piece from git history only when it saves real work: `host-runner/src/tmux.ts`, `worktree.ts`, `telegram-frontend/src/bot.ts` (the `allowedChatIds` handling), `linear-connector/src/github.ts` (`findPr`).

Work through the PRs in order. Each PR follows Kirill's ticket → PR workflow in the `robot-mill` Linear project and passes `mise run check`.

## Glossary

- **mill server**: the one long-running Bun/TypeScript process. It is the MCP server, the webhook receiver, the Telegram bot, the scheduler and the task store.
- **dispatcher**: an always-on Codex agent in tmux session `mill-dispatcher`. It turns Kirill's messages into tasks through MCP tools.
- **worker**: one slot in the pool. Each slot has an agent type: `claude` or `codex`. The default pool is 2 slots, one of each, set in config. A third type, `agy`, comes later (see Later: agy).
- **adapter**: per agent type, the launch command, the resume command, the skills folder, the MCP config writer, the turn-end hook and the plan-limit detector.
- **task**: one unit of work, with a Linear ticket, a branch, a worktree, a tmux session and a conversation id. Its **kind** is `build`, `review` or `fix`.
- **millwright**: the macOS user that runs everything. It is also the GitHub machine user the agents push as.
- **mill-inspector**: a GitHub App. It delivers webhooks for all of Kirill's repos, and reviewer agents post their reviews as `mill-inspector[bot]`.

## Hard rules

- Every agent runs **interactively in tmux**, so it bills against the subscription. Never use `claude -p` or `codex exec`: they bill a separate pool.
- The server sends text into a session with `tmux send-keys -l`, then a separate `Enter`.
- Workers run fully autonomous: Claude with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`.
- The guard rails:
  - the `millwright` OS user;
  - a non-admin GitHub identity;
  - the `robot-mill-guard` ruleset, which requires 1 approval with admin bypass;
  - `submit_review`, which accepts only `COMMENT` or `REQUEST_CHANGES`.

  The App key and the review event are never exposed to agents.
- Webhooks are public through Cloudflare Tunnel. Every request is verified first: GitHub by `X-Hub-Signature-256`, Linear by its `Linear-Signature` HMAC. Unsigned or mismatched requests get a 401. Every path except `/github` and `/linear` returns 404.
- Telegram accepts only `TELEGRAM_CHAT_ID`. Other chats are dropped silently.
- Each tool is logged in once, by hand, as `millwright` (`claude`, `codex login`, `gh auth login`). Credential files are never copied between machines.
- Update `AGENTS.md` in PR 1. The "LAN-only, no auth suggestions" line no longer holds for the webhook endpoints.

## Architecture

```
Telegram ──long poll──▶ mill server ◀──MCP (HTTP, 127.0.0.1)── dispatcher / workers / reviewers
hooks.kirhgoff.me ─cloudflared─▶ mill server  (/github from mill-inspector, /linear)
mill server ──tmux──▶ mill-dispatcher, mill-<task-id> sessions
mill server ──bun:sqlite──▶ ~/.local/state/mill/mill.db
```

- Each agent session gets the MCP URL `http://127.0.0.1:<port>/mcp?session=<name>`, written into its config by the adapter. The server knows the caller from `session` and refuses tools that don't belong to the caller's role.
- Secrets live in `~/.config/mill/mill.env`, which Kirill fills by hand:
  - `TELEGRAM_BOT_TOKEN` (reused from the old bot, in `~/.envs/robot-mill/` on peeper)
  - `TELEGRAM_CHAT_ID`
  - `LINEAR_API_KEY`
  - `LINEAR_WEBHOOK_SECRET`
  - `GITHUB_WEBHOOK_SECRET`
  - `GITHUB_APP_ID`
  - `GITHUB_APP_PRIVATE_KEY_PATH`

  GitHub pushes use `millwright`'s own `gh` login.
- Clones live at `~millwright/Projects/<repo>`, and worktrees at `~millwright/Projects/<repo>-<branch>`. The branch is `<ticket-id-lowercase>-<slug>`. Review worktrees are `<repo>-review-<pr>`, and they are removed when the review task ends.

## MCP tools

| Tool | Callers | Does |
|---|---|---|
| `submit_task(title, description, linear_project, worker?)` | dispatcher | Creates the Linear ticket (state Agent Queue, assigned to Kirill), queues a `build` task, returns the ticket id and URL |
| `list_tasks()`, `task_status(id)` | dispatcher | Read the task store |
| `answer(task, text)` | dispatcher | Types the text into the task's session |
| `stop_task(task)` | dispatcher | Kills the session and moves the ticket to Agent Failed with reason "stopped by Kirill" |
| `send_message(text, task?)` | all | Sends the text to Telegram, prefixed with the ticket id |
| `ask_question(task, text)` | all | Sends the text to Telegram and records `message_id → task`. A Telegram reply to that message is typed into the task's session |
| `prepare_worktree(repo)` | workers | Runs the ruleset check, clones or fetches, creates the worktree, returns its path. Refuses an unprotected repo (see Protection) |
| `complete_task(task, pr_url? , failure?)` | workers | Records the PR, or fails the task (ticket to Agent Failed, the reason posted as a comment, Telegram message) |
| `submit_review(task, event, body, comments[])` | reviewers | Posts as mill-inspector with an installation token. `event` must be `COMMENT` or `REQUEST_CHANGES` |

Workers resolve the repo from the ticket's Linear project with Kirill's Linear skill. The farm has no project config, so `prepare_worktree` is the first thing a worker calls.

## Task lifecycle

States: `queued → running ⇄ waiting_answer → pr_open → (fix/review tasks) → done | canceled | failed`. A task in `running` can also move to `paused_limit` and back.

1. **Intake.**
   - Telegram: a message that isn't a reply is typed into `mill-dispatcher`. The dispatcher calls `submit_task`.
   - Linear: a webhook for an issue moved into Agent Queue, whose id isn't in the store, becomes a `build` task directly, skipping the dispatcher. A `worker:claude` or `worker:codex` label pins the worker.
2. **Scheduling.**
   - A free slot takes the next task. Queue order is `fix`, then `review`, then `build`. A pinned task waits for its type.
   - A task holds its slot while it is `running`, `waiting_answer` or `paused_limit`, and releases it at `pr_open`.
   - The tmux session stays alive for later fix rounds.
3. **Start.** The server creates session `mill-<task-id>` in a neutral dir, launches the adapter command, and sends the task prompt: ticket id, URL, description, the tool contract, and "move the ticket to In Progress". The worker moves the ticket to In Progress, calls `prepare_worktree`, builds, opens the PR, links ticket and PR both ways, moves the ticket to In Review, and calls `complete_task`.
4. **Review.**
   - On `complete_task` with a PR, the server queues a `review` task. It prefers a free slot of a different agent type, and takes the same type when the others are busy.
   - The reviewer works in a fresh review worktree and calls `submit_review`.
   - The server counts inspector review rounds per PR. After round 2, or after a round with no findings, it sends Telegram "PR ready for you: <url>" and stops queuing reviews.
5. **Fix rounds.**
   - These events on a task's PR start a 3-minute debounce:
     - `pull_request_review` with action `submitted`, `pull_request_review_comment` or `issue_comment`;
     - from any sender except `millwright`. mill-inspector's reviews count.
   - When the debounce fires, the server queues a `fix` task on the same session.
   - The fix prompt says to fix each finding in its own commit, push, and reply in each thread: `RESOLVED in <sha> - …`, or the reason it was left unchanged.
6. **End.**
   - `pull_request` closed with `merged=true`: ticket to Done.
   - Closed without merging: ticket to Canceled.
   - Either way, the server kills the session, removes the worktree and branch, and sends a Telegram message.

### Backup completion

The turn-end hook calls `POST /hook/turn-end?session=<name>` with the payload: Claude `Stop` (`session_id`), Codex `notify` (thread id). It also gives the server the conversation id for resume.

If a `running` task ends a turn without calling `complete_task`, `ask_question` or `send_message` since its last prompt:
- first time, nudge: "Call complete_task or ask_question";
- second time, send Telegram "worker idle on <ticket>" and leave the task as it is.

### Plan limits

Each adapter detects its limit message, from the pane text or the hook payload, and parses the reset time. The task goes to `paused_limit` and keeps its slot, and no new task starts on that type until the reset, because the type's quota is exhausted. Telegram gets "<type> hit its limit, resets <time>". At reset plus 1 minute, the server sends "continue" to the same session and the task is `running` again. The other types keep serving the queue.

### Dispatcher resets

The server restarts `mill-dispatcher` fresh in three cases:
- every day at 04:00 while it is idle;
- after a turn where the latest Codex token count passes 60% of the context window;
- on Telegram `/reset`.

All state lives in the store, so a reset loses nothing.

### Restart and reconcile

On boot, the server:
1. loads the store and recreates `mill-dispatcher`;
2. relaunches each `running`, `waiting_answer` or `paused_limit` task with its adapter's resume command and the stored conversation id (`claude --resume <id>`, `codex resume <id>`), then sends "The farm restarted; continue where you left off";
3. reconciles the events it missed while down: `gh pr view` for every `pr_open` task (merged, closed, or new reviews since the last seen id), and a Linear query for Agent Queue issues missing from the store.

## Protection

`mill protect <repo>… | --all-linear` runs from Kirill's own account and `gh`. It upserts a `robot-mill-guard` ruleset on the default branch: PR required, 1 approval, bypass for the admin role. It also invites `millwright` as a collaborator with write access, and the server accepts the invitation as millwright.

`prepare_worktree` reads `GET /repos/{o}/{r}/rules/branches/{default}`. It refuses unless it finds a `pull_request` rule with `required_approving_review_count >= 1`. On refusal, the task fails and Kirill gets the exact `mill protect <repo>` command.

Kirill approves and merges millwright's PRs himself.

## Kirill's manual setup

Ship this as a wizard (`mattpocock-skills:wizard`) in PR 7. In order:

1. Create the macOS user `millwright`. Enable auto-login for it, and Fast User Switching, so it stays logged in behind Kirill's session. That gives it an unlocked keychain, launchd LaunchAgents, Xcode and the Simulator.
2. Create the GitHub machine user `millwright`, or the nearest free name. Add an SSH signing key generated as millwright on mimi, so commits show Verified. toni-the-bookmaker requires signed commits.
3. Create the GitHub App `mill-inspector`:
   - webhook `https://hooks.kirhgoff.me/github` with a secret;
   - permissions Pull requests write, Contents read, Metadata read;
   - events `pull_request`, `pull_request_review`, `pull_request_review_comment` and `issue_comment`;
   - installed on all repositories, private key saved to `GITHUB_APP_PRIVATE_KEY_PATH`.
4. Create the Cloudflare named tunnel and route DNS `hooks.kirhgoff.me` to it (the `kirhgoff.me` zone is already on Cloudflare). Use `cloudflared`; pipe credential output through `jq` to the non-secret fields.
5. Create the Linear webhook: `https://hooks.kirhgoff.me/linear`, Issue events, with a secret.
6. As millwright: `claude`, `codex login`, `gh auth login`. Then fill `mill.env`.
7. Run `mill protect --all-linear` as Kirill.

## PR plan

Each PR is done when `mise run check` passes, its listed behaviour is covered by tests that use a fake tmux and fake HTTP (no live agents), and the ticket is In Review.

1. **Clear the ground.**
   - Delete every old package, the Docker files, `install/`, `scripts/` and the `deps` task entries.
   - Stop and remove the old farm on peeper: its tmux services and `~/.envs/robot-mill/`. Keep a copy of the Telegram bot token for `mill.env`. Use the `peeper` skill.
   - Add the empty `mill/` Bun package to `mise` tasks and `hk`.
   - Rewrite `AGENTS.md` and `README.md` for the new farm.
   - Done when the repo holds only `mill/`, the configs and these docs, and peeper runs nothing from robot-mill.
2. **Core.** The task store, tmux control, worktrees, adapters for `claude` and `codex`, the MCP server with every tool except `submit_review`, and scheduling with slots, priority and pinning.
   - Done when a test drives a task from queued to `pr_open` through the fakes.
   - Also done when one real Claude task runs end to end on mimi by hand.
3. **Telegram and dispatcher.** The allowlist, intake into the dispatcher, reply routing to `ask_question`, `/reset`, and dispatcher resets including the token-count check.
4. **Linear.** Ticket creation in `submit_task`, every state transition named above, and the `/linear` webhook intake with label pinning.
5. **GitHub.**
   - The `/github` webhook with signature checks, review tasks, `submit_review` with App installation tokens, the 3-minute debounce, the 2-round cap, and the merged/closed endings.
   - `mill protect`.
   - Done when every event in "Fix rounds" and "End" has a test, including mill-inspector triggering a fix and millwright not triggering one.
6. **Resilience.** The turn-end hook endpoint and nudges, plan-limit pause and resume for each adapter, and restart/reconcile.
   - Done when a test kills every fake session, reboots the server, and gets every in-flight task resumed by conversation id.
7. **Install.**
   - An idempotent `install.sh` run as millwright: Homebrew `tmux`, `gh`, `cloudflared`; mise; the Claude and Codex CLIs; clone Kirill's dotfiles repo and link his skills into each adapter's skills folder; write each agent's MCP and hook config.
   - LaunchAgents for the mill server and cloudflared, with `KeepAlive`.
   - The setup wizard.
   - Done when running the install twice changes nothing the second time.

## Verify first

Check each of these on mimi before building on it. Record the answer in the adapter's code or in `AGENTS.md`.

- **Keychain:** Claude can read millwright's keychain when the server starts from a LaunchAgent.
- **Codex:** where the session logs record token counts and the context window size, for the 60% reset. Also the exact notify payload, the resume command and the skills folder.
- **Name:** the GitHub username `millwright` is free.

## Later: agy

Out of scope until the Claude and Codex farm works end to end. Then add an `agy` adapter, PR 8, for Google's Antigravity CLI running Gemini 4 Neon on Kirill's Google AI subscription. Make it a third default slot, and add `worker:agy` as a label.

What's known so far comes from secondary sources:
- It runs interactively, and `agy -p` is headless (avoid it).
- MCP config is reported at `~/.gemini/config/mcp_config.json`, and it reads `AGENTS.md`, with workspace skills in `.agents/skills/`.
- It resumes with `agy --conversation <id>` and has an `always-proceed` mode.
- Its login lives in the system keyring.
- `/usage` shows a 5-hour quota window and a weekly one.

Check first:
- its turn-end hook event (if none exists, use tmux pane idle detection: pane unchanged for 30 s with its prompt visible);
- the `always-proceed` flag;
- its global skills folder;
- its limit message format;
- that it can read millwright's keychain;
- whether Orchestrator (Neon) is selectable in the CLI. Otherwise use `--model gemini-4-neon` at effort `high`.

## Linux later

Not built now. If the farm moves to Linux:

- Swap launchd for systemd user units, with `loginctl enable-linger millwright`.
- Swap Homebrew for apt, and the cloudflared package for the Debian one.
- Give the headless user a keyring: run `gnome-keyring-daemon` under `dbus-run-session`, or find each tool's file-based credential fallback.
- Drop the Xcode and Simulator steps. iOS tasks need a Mac worker, so pin them away.
- Hide each of these behind an OS switch in `install.sh` and in the supervisor writer.
