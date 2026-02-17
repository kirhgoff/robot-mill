# robot-runner

See `PLAN.md` for the full plan.

Quick start (local):
- `bun install`
- Create tasks in `tasks/` (one `<id>.md` per task)
- Run runner: `TASK_DIR=./tasks WORKSPACES_DIR=./workspaces bun apps/runner/src/main.ts`

Docker:
- `docker compose up --build`
