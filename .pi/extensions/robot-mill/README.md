# Robot Mill Extension

Autonomous task processing system with multi-agent workflow chains.

## Architecture

```
robot-mill/
├── index.ts              # Entry point — wires everything together
├── types.ts              # Shared type definitions
├── state.ts              # State management & execution tracking
├── config.ts             # Configuration loading
├── helpers/
│   ├── markdown.ts       # Task file parsing (frontmatter, notes)
│   ├── git.ts            # Git operations & worktree management
│   └── agents.ts         # Agent/chain parsing & execution
├── tools/
│   ├── tasks.ts          # task_list, task_get, task_append, task_status
│   ├── worktrees.ts      # worktree_list, worktree_create, worktree_enter
│   ├── git.ts            # git_ops (status, commit, push, pull)
│   ├── workflow.ts       # workflow (next, status, finish)
│   └── chains.ts         # run_mill, need_clarification, submit_work
└── ui/
    └── widget.ts         # TUI widget showing execution progress
```

## Agents

Located in `.pi/agents/`:

| Agent | Role | Tools |
|-------|------|-------|
| **understand** | Deep codebase analysis | read, grep, find, ls |
| **planner** | Implementation planning | read, grep, find, ls |
| **builder** | Code implementation | read, write, edit, bash, grep, find, ls |
| **tester** | Test writing/execution | read, write, edit, bash, grep, find, ls |
| **reviewer** | Code review | read, bash, grep, find, ls |
| **clarifier** | Question identification | read, grep, find, ls |

## Workflow Chains

Defined in `.pi/agents/mill-chains.yaml`:

### Initial Task Processing
| Chain | Description | Transition |
|-------|-------------|------------|
| `full-mill` | Complete workflow (understand → plan → build → test → review) | todo → in_progress → in_review |
| `quick-mill` | Fast implementation (understand → plan → build) | todo → in_progress |

### Clarification
| Chain | Description | Transition |
|-------|-------------|------------|
| `clarify` | Identify unclear requirements | in_progress → needs_info |
| `deep-clarify` | Triple-pass clarification | in_progress → needs_info |

### Resume After Human Input
| Chain | Description | Transition |
|-------|-------------|------------|
| `resume-from-clarify` | Continue after human answered questions | needs_info → in_progress |
| `resume-from-plan` | Continue after human approved plan | needs_info → in_progress |
| `resume-from-review` | Address review feedback | in_review → in_progress |

### Review
| Chain | Description | Transition |
|-------|-------------|------------|
| `test-review` | Test and review existing changes | in_progress → in_review |
| `double-review` | Two-pass review | in_progress → in_review |

### Planning Only
| Chain | Description | Transition |
|-------|-------------|------------|
| `plan-only` | Just create a plan | (no transition) |
| `iterative-plan` | Plan, critique, refine | (no transition) |

## Usage

```bash
# Start with the extension
pi -e .pi/extensions/robot-mill

# Pick up next task
> workflow next

# Run a workflow chain
> run_mill chain="full-mill"

# If requirements unclear
> run_mill chain="clarify"
> need_clarification questions="..."

# Complete the task
> workflow finish
```

## TUI Widget

The extension displays a real-time status widget showing:
- Current task being worked on
- Chain being executed with step indicators: `[✓ understand] → [● planner] → [○ builder]`
- Progress bar with percentage and total elapsed time
- **Live agent output** — last 5 lines from the running agent
- Completed steps summary with per-step elapsed times

Example widget display:
```
──────────────────────────────────────────────────────────────
 ● jora-002-remove-user-service → full-mill
 [✓ understand] → [● planner] → [○ builder] → [○ tester] → [○ reviewer]
 Progress: ████████░░░░░░░░ 40% │ Total: 2m 15s
 ┌─ Planner (45s)
 │  ### Step 1: Create Protocol
 │  - **Files**: UserService.swift, UserServiceProtocol.swift
 │  - **Changes**: Extract interface from UserService
 └─ - **Tests**: Update UserServiceTests.swift

 Completed: ✓Understand(1m 30s)
──────────────────────────────────────────────────────────────
```

## Task Notes

Each agent's output is automatically saved to the task file as a note:
- **understand** agent → `general` note type
- **planner** agent → `plan` note type  
- **builder** agent → `progress` note type
- **tester** agent → `progress` note type
- **reviewer** agent → `review` note type
- **clarifier** agent → `question` note type

This creates a complete audit trail of all work done on the task.

## Branch Naming

Branches are automatically named with a slug from the task title:
- Task: `jora-002` with title "Remove User Service Singleton"
- Branch: `robot/jora-002-remove-user-service-singleton`

## Commands

| Command | Description |
|---------|-------------|
| `/mill-chains` | List available workflow chains |
| `/mill-agents` | List available agents |
| `/mill-status` | Show current task and execution status |
