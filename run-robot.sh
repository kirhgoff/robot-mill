#!/bin/bash
# Robot Mill - Run the autonomous robot agent
#
# Usage:
#   ./run-robot.sh              # Interactive mode
#   ./run-robot.sh --auto       # Autonomous mode (keeps picking tasks)
#   ./run-robot.sh --task ID    # Work on a specific task
#
# Environment variables:
#   ANTHROPIC_API_KEY    - Required for Claude
#   OPENAI_API_KEY       - Required for OpenAI/Codex
#   ROBOT_PROVIDER       - LLM provider (default: anthropic)
#   ROBOT_MODEL          - Model name (default: claude-sonnet-4-20250514)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env file if it exists
if [[ -f .env ]]; then
  set -a  # auto-export variables
  source .env
  set +a
fi

# Default settings
PROVIDER="${ROBOT_PROVIDER:-anthropic}"
MODEL="${ROBOT_MODEL:-claude-sonnet-4-20250514}"
AGENT="robot"

# Parse arguments
AUTO_MODE=false
SPECIFIC_TASK=""
INITIAL_PROMPT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --auto)
      AUTO_MODE=true
      INITIAL_PROMPT="You are in autonomous mode. Start by running 'workflow next' to pick up a task. After completing each task, immediately pick up the next one. Continue until there are no more tasks."
      shift
      ;;
    --task)
      SPECIFIC_TASK="$2"
      INITIAL_PROMPT="Work on task $SPECIFIC_TASK. Start by running 'task_get id=\"$SPECIFIC_TASK\"' to understand the task, then create a worktree and implement it."
      shift 2
      ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check for API key
case "$PROVIDER" in
  anthropic)
    if [[ -z "$ANTHROPIC_API_KEY" ]]; then
      echo "Error: ANTHROPIC_API_KEY is required"
      exit 1
    fi
    ;;
  openai)
    if [[ -z "$OPENAI_API_KEY" ]]; then
      echo "Error: OPENAI_API_KEY is required"
      exit 1
    fi
    ;;
esac

echo "🤖 Robot Mill"
echo "   Provider: $PROVIDER"
echo "   Model: $MODEL"
echo "   Mode: $([ "$AUTO_MODE" = true ] && echo 'autonomous' || echo 'interactive')"
echo ""

# Run pi with the robot agent and extension
exec pi \
  --agent "$AGENT" \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  -e .pi/extensions/robot-mill.ts \
  ${INITIAL_PROMPT:+--prompt "$INITIAL_PROMPT"}
