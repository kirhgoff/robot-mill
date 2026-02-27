# Robot Mill - Task Automation Commands

# Default: show help
default:
    @just --list

# ─────────────────────────────────────────────────────────────────────────────
# Robot Commands
# ─────────────────────────────────────────────────────────────────────────────

# Run robot in interactive mode
robot:
    ./run-robot.sh

# Run robot in autonomous mode (picks up tasks automatically)
robot-auto:
    ./run-robot.sh --auto

# Run robot on a specific task
robot-task task_id:
    ./run-robot.sh --task {{task_id}}

# Run robot with OpenAI instead of Anthropic
robot-openai:
    ROBOT_PROVIDER=openai ROBOT_MODEL=gpt-4o ./run-robot.sh

# ─────────────────────────────────────────────────────────────────────────────
# Task Management
# ─────────────────────────────────────────────────────────────────────────────

# List all tasks
tasks:
    ./task-cli.sh list all

# List available tasks (todo status)
tasks-available:
    ./task-cli.sh list todo

# List tasks needing review
tasks-review:
    ./task-cli.sh list in_review

# List tasks needing info
tasks-blocked:
    ./task-cli.sh list needs_info

# Show a specific task
task id:
    ./task-cli.sh show {{id}}

# Create a new task (interactive)
task-create:
    ./task-cli.sh create

# Answer a robot's question
task-answer id answer:
    ./task-cli.sh answer {{id}} "{{answer}}"

# Approve a completed task
task-approve id:
    ./task-cli.sh approve {{id}}

# Request changes on a task
task-reject id reason:
    ./task-cli.sh reject {{id}} "{{reason}}"

# ─────────────────────────────────────────────────────────────────────────────
# Docker Commands
# ─────────────────────────────────────────────────────────────────────────────

# Build Docker image
docker-build:
    docker compose build

# Run robot in Docker (interactive)
docker-robot:
    docker compose run --rm robot

# Run robot in Docker (autonomous, background)
docker-robot-auto:
    docker compose up -d robot

# Stop Docker robot
docker-stop:
    docker compose down

# View robot logs
docker-logs:
    docker compose logs -f robot

# ─────────────────────────────────────────────────────────────────────────────
# Development
# ─────────────────────────────────────────────────────────────────────────────

# Install dependencies
install:
    bun install

# Run Pi with the extension (development)
dev:
    pi -e .pi/extensions/robot-mill.ts

# Test the extension
test:
    bun test

# Clean worktrees
clean-worktrees:
    rm -rf .worktrees/*

# ─────────────────────────────────────────────────────────────────────────────
# Git Worktrees
# ─────────────────────────────────────────────────────────────────────────────

# List all worktrees
worktrees:
    git worktree list

# Prune stale worktrees
worktrees-prune:
    git worktree prune
