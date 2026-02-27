#!/bin/bash
# Robot Mill - Task Management CLI
#
# Usage:
#   ./task-cli.sh list                    # List all tasks
#   ./task-cli.sh list todo               # List tasks by status
#   ./task-cli.sh show <id>               # Show task details
#   ./task-cli.sh create                  # Create new task (interactive)
#   ./task-cli.sh answer <id> "response"  # Answer robot's question
#   ./task-cli.sh approve <id>            # Approve completed task
#   ./task-cli.sh reject <id> "reason"    # Request changes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_DIR="$SCRIPT_DIR/tasks"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

status_color() {
  case $1 in
    todo) echo -e "${BLUE}$1${NC}" ;;
    in_progress) echo -e "${YELLOW}$1${NC}" ;;
    needs_info) echo -e "${RED}$1${NC}" ;;
    in_review) echo -e "${GREEN}$1${NC}" ;;
    done) echo -e "${GREEN}$1${NC}" ;;
    *) echo "$1" ;;
  esac
}

list_tasks() {
  local filter="${1:-all}"
  echo "Tasks ($filter):"
  echo "─────────────────────────────────────────────────────────"
  
  for file in "$TASKS_DIR"/*.md; do
    [[ -f "$file" ]] || continue
    
    # Parse frontmatter
    local id=$(grep "^id:" "$file" | head -1 | cut -d: -f2 | xargs)
    local title=$(grep "^title:" "$file" | head -1 | cut -d: -f2- | xargs)
    local status=$(grep "^status:" "$file" | head -1 | cut -d: -f2 | xargs)
    local buddy=$(grep "^humanBuddy:" "$file" | head -1 | cut -d: -f2 | xargs)
    local assignee=$(grep "^assignee:" "$file" | head -1 | cut -d: -f2 | xargs)
    
    if [[ "$filter" == "all" ]] || [[ "$status" == "$filter" ]]; then
      printf "[%s] %-12s %-40s @%s\n" "$(status_color $status)" "$id" "${title:0:40}" "${assignee:-$buddy}"
    fi
  done
}

show_task() {
  local id="$1"
  local file="$TASKS_DIR/$id.md"
  
  if [[ ! -f "$file" ]]; then
    echo "Task not found: $id"
    exit 1
  fi
  
  cat "$file"
}

create_task() {
  echo "Create new task"
  echo "─────────────────────────────────────────────────────────"
  
  read -p "ID (e.g., task-003): " id
  read -p "Title: " title
  read -p "Human buddy: " buddy
  read -p "Repository URL: " repo
  read -p "Priority (1-5, 1=highest): " priority
  read -p "Labels (comma-separated): " labels
  
  echo "Description (end with Ctrl+D):"
  description=$(cat)
  
  local file="$TASKS_DIR/$id.md"
  local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  # Convert labels to YAML array format
  local labels_yaml="[$(echo "$labels" | sed 's/,/, /g')]"
  
  cat > "$file" << EOF
---
id: $id
title: $title
status: todo
humanBuddy: $buddy
repository: $repo
branch: null
assignee: null
priority: ${priority:-3}
labels: $labels_yaml
createdAt: $now
updatedAt: $now
---

## Description

$description

## Notes

EOF

  echo ""
  echo "✓ Created task: $file"
}

answer_question() {
  local id="$1"
  local answer="$2"
  local file="$TASKS_DIR/$id.md"
  
  if [[ ! -f "$file" ]]; then
    echo "Task not found: $id"
    exit 1
  fi
  
  local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local buddy=$(grep "^humanBuddy:" "$file" | head -1 | cut -d: -f2 | xargs)
  
  # Append answer note
  cat >> "$file" << EOF

### $now - $buddy - answer

$answer

EOF

  # Update status back to todo and assignee to null
  sed -i '' "s/^status:.*/status: todo/" "$file"
  sed -i '' "s/^assignee:.*/assignee: null/" "$file"
  sed -i '' "s/^updatedAt:.*/updatedAt: $now/" "$file"
  
  echo "✓ Answer added and task moved back to 'todo'"
}

approve_task() {
  local id="$1"
  local file="$TASKS_DIR/$id.md"
  
  if [[ ! -f "$file" ]]; then
    echo "Task not found: $id"
    exit 1
  fi
  
  local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local buddy=$(grep "^humanBuddy:" "$file" | head -1 | cut -d: -f2 | xargs)
  
  # Append review note
  cat >> "$file" << EOF

### $now - $buddy - review

✓ Approved and merged.

EOF

  # Update status to done
  sed -i '' "s/^status:.*/status: done/" "$file"
  sed -i '' "s/^assignee:.*/assignee: null/" "$file"
  sed -i '' "s/^updatedAt:.*/updatedAt: $now/" "$file"
  
  echo "✓ Task approved and marked as done"
}

reject_task() {
  local id="$1"
  local reason="$2"
  local file="$TASKS_DIR/$id.md"
  
  if [[ ! -f "$file" ]]; then
    echo "Task not found: $id"
    exit 1
  fi
  
  local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local buddy=$(grep "^humanBuddy:" "$file" | head -1 | cut -d: -f2 | xargs)
  
  # Append review note
  cat >> "$file" << EOF

### $now - $buddy - review

Changes requested:

$reason

EOF

  # Update status back to todo
  sed -i '' "s/^status:.*/status: todo/" "$file"
  sed -i '' "s/^assignee:.*/assignee: null/" "$file"
  sed -i '' "s/^updatedAt:.*/updatedAt: $now/" "$file"
  
  echo "✓ Task sent back for changes"
}

# Main
case "${1:-list}" in
  list)
    list_tasks "${2:-all}"
    ;;
  show)
    show_task "$2"
    ;;
  create)
    create_task
    ;;
  answer)
    answer_question "$2" "$3"
    ;;
  approve)
    approve_task "$2"
    ;;
  reject)
    reject_task "$2" "$3"
    ;;
  *)
    echo "Usage: $0 {list|show|create|answer|approve|reject}"
    exit 1
    ;;
esac
