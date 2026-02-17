# Robot Runner + Pluggable TaskSources (MVP)

## Objective
Build a pluggable workflow runner ("robot") that repeatedly picks an available task from a TaskSource, plans work, optionally asks for clarification, and otherwise implements changes in the task's repo on a branch and hands the task back for review.

Primary constraints:
- Task source is pluggable; MVP uses Markdown files with frontmatter.
- Robot (LLM/coding agent) is pluggable.
- Provide a Docker image that runs the runner with all required tooling.
- Implementation preference: TypeScript + Bun.

## Scope (MVP)

### TaskSource contract
Implement a `TaskSource` interface that supports:
- `getTaskList()` => list of tasks available for robot pickup (unassigned to buddy).
- `getTaskDetails(id)` => full task details, including assignee.
- `appendDetails(id, entry)` => append-only update (plan, docs, questions).
- `startWorking(id)` => mark `in_progress`, assign to robot.
- `stopWorkingNeedInfo(id)` => mark `todo`, assign back to buddy.
- `stopWorkingNeedReview(id)` => mark `in_review`, assign back to buddy.

MVP implementation: `tasksource-markdown` using one file per task (`.md`) with YAML frontmatter.

### Runner workflow
Single-worker loop:
1) `getTaskList()` and pick the first task.
2) `startWorking(id)` atomically claim.
3) `getTaskDetails(id)`.
4) Prepare repo workspace (git clone/fetch + branch + worktree).
5) Ask robot to generate a plan; `appendDetails(plan)`.
6) If clarification needed:
   - `appendDetails(questions with options)`.
   - `stopWorkingNeedInfo(id)`.
   - Loop.
7) If enough info:
   - run implementation via pluggable Robot provider.
   - `appendDetails(implementation notes)`.
   - `stopWorkingNeedReview(id)`.
   - Loop.

### Robot abstraction
Provide an interface that can be implemented via:
- API-backed LLMs (OpenAI/Anthropic).
- Local external agent CLI invocation (recommended for MVP so repo editing stays delegated).

MVP recommendation: `robot-local` that shells out to a configured command (e.g. your agent CLI) with a structured prompt and consumes a structured response.

### Docker
Ship a Docker image that includes:
- bun runtime
- git + ssh client
- optional: `gh` (future PR support)

The container runs the runner; tasks and workspaces are mounted.

## Data model (Markdown TaskSource)

### File layout
`/tasks/<id>.md`

### Frontmatter (YAML)
Fields:
- `id`: string
- `title`: string
- `status`: `todo | in_progress | in_review`
- `buddy`: string (human responsible)
- `assignedTo`: `null | string` (e.g. `robot:runner-1` or buddy)
- `repo`: string (git remote url)
- `branch`: string | null (optional)
- `updatedAt`: ISO string

### Body structure
Sections:
- `## Description`
- `## Details (append-only)`

`appendDetails` appends a timestamped entry under `## Details (append-only)` without rewriting older entries.

### Pickup rules (MVP)
`getTaskList()` returns tasks where:
- `status == todo`
- `assignedTo == null`

### Claim/lock semantics
`startWorking(id)` must be atomic at file-level:
- If `assignedTo != null` or `status != todo`, fail with `AlreadyClaimed`.

## Repo workspace strategy
Use `git worktree` to isolate tasks:
- Base clones stored under `/workspaces/repos/<repoSlug>`
- Worktrees under `/workspaces/worktrees/<taskId>`

Branch selection:
- If task frontmatter has `branch`, fetch and checkout it.
- Else create `robot/<id>-<slug>` based off default branch.

## Deliverables
- `packages/core`: interfaces/types + workflow state machine
- `packages/tasksource-markdown`: implementation + tests + CLI `task-md`
- `packages/robot-local`: robot provider that shells out to external agent
- `apps/runner`: long-running process
- Dockerfile + docker-compose example
- Example tasks folder and docs

## Repo structure (proposed)
- `packages/core`
- `packages/tasksource-markdown`
- `packages/robot-local`
- `packages/git`
- `apps/runner`

## Milestones
1) Project scaffold: Bun workspaces, TypeScript config, shared linting.
2) Core types + TaskSource interface.
3) Markdown TaskSource + `task-md` CLI.
4) Runner skeleton: pick/claim/details + logging.
5) Git workspace: clone/fetch, branch creation, worktree.
6) Robot-local provider integration.
7) Docker image + compose example.

## Non-goals (MVP)
- Jira integration (planned as separate package).
- Multi-worker coordination.
- PR creation / CI integration.
- Advanced stale-claim recovery.
