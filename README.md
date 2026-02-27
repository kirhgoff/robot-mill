# Robot Mill 🤖

An autonomous task-processing workflow system powered by AI agents. Robots pick up tasks, plan implementations, write code, and submit for human review.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        ROBOT WORKFLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐  │
│   │  TODO   │ ──► │ PLANNING│ ──► │IMPLEMENT│ ──► │ REVIEW  │  │
│   └─────────┘     └─────────┘     └─────────┘     └─────────┘  │
│        │               │               │               │        │
│        │               │               │               │        │
│        ▼               ▼               ▼               ▼        │
│   Robot picks    Robot reads     Robot codes    Human reviews   │
│   up task        & plans         in worktree    & approves      │
│                       │                               │         │
│                       ▼                               ▼         │
│                 ┌───────────┐                   ┌─────────┐     │
│                 │NEEDS INFO │ ◄──────────────── │  DONE   │     │
│                 └───────────┘                   └─────────┘     │
│                       │                                         │
│                       ▼                                         │
│                 Human answers                                   │
│                 question                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Pluggable Task Sources**: Markdown files (MVP), Jira (included), extensible
- **Parallel Execution**: Git worktrees enable working on multiple tasks simultaneously
- **Human-in-the-Loop**: Questions, plan approval, and code review
- **LLM Agnostic**: Supports Claude, GPT-4, and other providers
- **Docker Ready**: Run anywhere with a single container

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure API Key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

### 3. Create a Task

```bash
./task-cli.sh create
# Follow the prompts to create a task
```

Or create a markdown file in `tasks/`:

```markdown
---
id: task-001
title: Implement user authentication
status: todo
humanBuddy: kirill
repository: https://github.com/example/repo
branch: null
assignee: null
priority: 1
labels: [backend, auth]
createdAt: 2025-01-15T10:00:00Z
updatedAt: 2025-01-15T10:00:00Z
---

## Description

Add a login endpoint that validates credentials and returns a JWT.

## Notes

```

### 4. Run the Robot

```bash
# Interactive mode
./run-robot.sh

# Autonomous mode (keeps picking tasks)
./run-robot.sh --auto

# Work on specific task
./run-robot.sh --task task-001
```

### 5. Review & Approve

```bash
# List tasks needing review
./task-cli.sh list in_review

# Approve a task
./task-cli.sh approve task-001

# Or request changes
./task-cli.sh reject task-001 "Please add input validation"
```

## Architecture

```
robot-mill/
├── .pi/
│   ├── agents/
│   │   └── robot.md           # Agent persona & instructions
│   └── extensions/
│       └── robot-mill.ts      # Pi extension with all tools
├── src/
│   ├── types.ts               # Core types & interfaces
│   ├── sources/
│   │   ├── index.ts           # Task source factory
│   │   ├── markdown-source.ts # Markdown file implementation
│   │   └── jira-source.ts     # Jira API implementation
│   └── git/
│       └── worktree-manager.ts # Git worktree operations
├── tasks/                      # Task markdown files
├── .worktrees/                 # Git worktrees (one per task)
├── run-robot.sh               # Run the robot agent
├── task-cli.sh                # Task management CLI
├── Dockerfile                 # Docker container
├── docker-compose.yml         # Docker Compose config
└── justfile                   # Just commands
```

## Task Source Interface

The `TaskSource` interface enables pluggable task management:

```typescript
interface TaskSource {
  getTaskList(): Promise<TaskSummary[]>;
  getTaskDetails(id: string): Promise<TaskDetails | null>;
  appendDetails(id: string, input: AppendDetailsInput): Promise<void>;
  startWorking(id: string): Promise<void>;
  stopWorkingNeedInfo(id: string): Promise<void>;
  stopWorkingNeedReview(id: string): Promise<void>;
  markComplete(id: string): Promise<void>;
}
```

### Included Implementations

#### Markdown (Default)

Tasks are markdown files with YAML frontmatter. Simple, version-controllable, no dependencies.

```bash
# Config in .robot-mill.json
{
  "taskSource": "markdown",
  "tasksDir": "./tasks"
}
```

#### Jira

Connect to Atlassian Jira for enterprise task management.

```bash
# Environment variables
export JIRA_HOST=company.atlassian.net
export JIRA_EMAIL=robot@company.com
export JIRA_API_TOKEN=...
export JIRA_PROJECT=PROJ

# Config in .robot-mill.json
{
  "taskSource": "jira",
  "jira": {
    "host": "company.atlassian.net",
    "project": "PROJ"
  }
}
```

## Git Worktrees

Robot Mill uses git worktrees for parallel task execution:

```
main-repo/                    # Main repository (don't work here)
.worktrees/
├── task-001/                 # Worktree for task-001
│   ├── .robot-task          # Task ID marker
│   └── ...                  # Full repo checkout on robot/task-001 branch
├── task-002/                 # Worktree for task-002
│   └── ...                  # Separate branch, separate state
```

Benefits:
- **Isolation**: Each task has its own working directory
- **Parallel Work**: Robot can switch between tasks instantly
- **Clean State**: No uncommitted changes polluting other tasks
- **Easy Cleanup**: Remove worktree when task is done

## Docker

### Build & Run

```bash
# Build
docker compose build

# Run interactively
docker compose run --rm robot

# Run autonomously in background
docker compose up -d robot

# View logs
docker compose logs -f robot
```

### Environment Variables

Create a `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...  # Optional
ROBOT_PROVIDER=anthropic
ROBOT_MODEL=claude-sonnet-4-20250514

# Jira (optional)
JIRA_HOST=company.atlassian.net
JIRA_EMAIL=robot@company.com
JIRA_API_TOKEN=...
JIRA_PROJECT=PROJ
```

## Commands (justfile)

```bash
just                    # Show all commands

# Robot
just robot              # Interactive mode
just robot-auto         # Autonomous mode
just robot-task ID      # Specific task

# Tasks
just tasks              # List all
just tasks-available    # List todo
just tasks-review       # List in_review
just task ID            # Show task
just task-create        # Create new
just task-approve ID    # Approve
just task-reject ID "reason"  # Request changes

# Docker
just docker-build       # Build image
just docker-robot       # Run in Docker
just docker-robot-auto  # Run autonomous in Docker
```

## Extending

### Add a New Task Source

1. Implement the `TaskSource` interface:

```typescript
// src/sources/linear-source.ts
export class LinearTaskSource implements TaskSource {
  // Implement all methods
}
```

2. Add to the factory:

```typescript
// src/sources/index.ts
case "linear":
  return new LinearTaskSource(config);
```

3. Update config options.

### Customize the Agent

Edit `.pi/agents/robot.md` to change:
- Personality and communication style
- Workflow rules and guidelines
- Tool usage patterns

### Add Custom Tools

Edit `.pi/extensions/robot-mill.ts` to add new tools:

```typescript
pi.registerTool({
  name: "my_tool",
  description: "...",
  parameters: MySchema,
  async execute(_id, params) {
    // Implementation
  },
});
```

## License

MIT
