/**
 * Robot Mill Extension for Pi
 * 
 * Autonomous task processing system with multi-agent workflow chains.
 * 
 * Features:
 * - Task management (markdown-based task queue)
 * - Git worktree isolation (parallel task execution)
 * - Multi-agent workflow chains (understand → plan → build → test → review)
 * - Real-time TUI widget showing execution progress
 * 
 * Agents:
 * - understand: Deep codebase analysis
 * - planner: Implementation planning
 * - builder: Code implementation
 * - tester: Test writing/execution
 * - reviewer: Code review
 * - clarifier: Question identification
 * 
 * Usage: pi -e .pi/extensions/robot-mill
 * 
 * @see .pi/agents/mill-chains.yaml for workflow definitions
 * @see ./README.md for full documentation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "path";

// State & Config
import { createState } from "./state.ts";
import { loadConfig } from "./config.ts";

// Helpers
import { scanAgents, loadChains } from "./helpers/agents.ts";

// Tools
import { registerTaskTools } from "./tools/tasks.ts";
import { registerWorktreeTools } from "./tools/worktrees.ts";
import { registerGitTools } from "./tools/git.ts";
import { registerWorkflowTools } from "./tools/workflow.ts";
import { registerChainTools } from "./tools/chains.ts";

// UI
import { initWidget, disposeWidget, updateWidget } from "./ui/widget.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export default function robotMill(pi: ExtensionAPI) {
  // Create shared state
  const state = createState();

  // ─────────────────────────────────────────────────────────────────────────────
  // Register Tools
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Task management: task_list, task_get, task_append, task_status
  registerTaskTools(pi, state);
  
  // Git worktrees: worktree_list, worktree_create, worktree_enter
  registerWorktreeTools(pi, state);
  
  // Git operations: git_ops (status, commit, push, pull)
  registerGitTools(pi, state);
  
  // High-level workflow: workflow (next, status, finish)
  registerWorkflowTools(pi, state);
  
  // Chain execution: run_mill, need_clarification, submit_work
  registerChainTools(pi, state);

  // ─────────────────────────────────────────────────────────────────────────────
  // Commands
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("mill-chains", {
    description: "List available workflow chains",
    handler: async (_args, ctx) => {
      if (state.chains.length === 0) {
        ctx.ui.notify("No chains loaded. Check .pi/agents/mill-chains.yaml", "warning");
        return;
      }
      const list = state.chains.map((c) => `• ${c.name}: ${c.description}`).join("\n");
      ctx.ui.notify(`Available Chains:\n\n${list}`, "info");
    },
  });

  pi.registerCommand("mill-agents", {
    description: "List available agents",
    handler: async (_args, ctx) => {
      if (state.agents.size === 0) {
        ctx.ui.notify("No agents loaded. Check .pi/agents/*.md", "warning");
        return;
      }
      const list = Array.from(state.agents.values())
        .map((a) => `• ${a.name}: ${a.description}`)
        .join("\n");
      ctx.ui.notify(`Available Agents:\n\n${list}`, "info");
    },
  });

  pi.registerCommand("mill-status", {
    description: "Show current task and execution status",
    handler: async (_args, ctx) => {
      const { execution, currentTaskId, currentWorktree } = state;
      
      let msg = `🤖 Robot Mill Status\n\n`;
      msg += `Task: ${currentTaskId || "(none)"}\n`;
      msg += `Worktree: ${currentWorktree || "(main)"}\n`;
      
      if (execution.status !== "idle") {
        msg += `\nExecution:\n`;
        msg += `  Chain: ${execution.chainName}\n`;
        msg += `  Step: ${execution.currentStep + 1}/${execution.steps.length}\n`;
        msg += `  Status: ${execution.status}\n`;
        
        const runningStep = execution.steps.find(s => s.status === "running");
        if (runningStep) {
          msg += `  Agent: ${runningStep.agent}\n`;
        }
      }
      
      ctx.ui.notify(msg, "info");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Load configuration
    await loadConfig(state, ctx.cwd);
    
    // Scan for agents
    state.agents = scanAgents([
      join(ctx.cwd, ".pi", "agents"),
      join(ctx.cwd, "agents"),
    ]);
    
    // Load workflow chains
    state.chains = loadChains(ctx.cwd);
    
    // Initialize TUI widget
    initWidget(ctx, state);
    
    // Show startup notification
    ctx.ui.notify(
      `🤖 Robot Mill Ready\n\n` +
      `Agents: ${state.agents.size} loaded\n` +
      `Chains: ${state.chains.length} loaded\n\n` +
      `Commands:\n` +
      `  /mill-chains  List workflow chains\n` +
      `  /mill-agents  List agents\n` +
      `  /mill-status  Show status\n\n` +
      `Start with: workflow next`,
      "info"
    );
  });

  pi.on("session_shutdown", async () => {
    disposeWidget();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // System Prompt Enhancement
  // ─────────────────────────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    const chainList = state.chains
      .map((c) => `- **${c.name}**: ${c.description}`)
      .join("\n");
    
    const taskInfo = state.currentTaskId
      ? `Current Task: ${state.currentTaskId}`
      : "No task loaded. Use `workflow next` to pick one up.";

    return {
      systemPrompt: `You are a robot worker in the Robot Mill system. You process development tasks using multi-agent workflow chains.

## Status
${taskInfo}

## Available Tools

### Task Management
- \`task_list\` - List tasks (default: todo, use status="all" for all)
- \`task_get\` - Get full task details
- \`task_append\` - Add notes/plans/questions to a task
- \`task_status\` - Change task status

### Git Worktrees
- \`worktree_list\` - List all worktrees
- \`worktree_create\` - Create worktree for a task
- \`worktree_enter\` - Enter a task's worktree

### Git Operations
- \`git_ops\` - status, commit, push, pull

### Workflow
- \`workflow next\` - Pick up next available task
- \`workflow status\` - Show current status
- \`workflow finish\` - Complete task (commit, push, submit for review)

### Chain Execution
- \`run_mill\` - Execute a workflow chain
- \`need_clarification\` - Pause and ask human for info
- \`submit_work\` - Submit completed work for review

## Available Chains
${chainList}

## Workflow

1. **Pick task**: \`workflow next\`
2. **Run chain**: \`run_mill chain="full-mill"\`
3. **Complete**: \`workflow finish\` or \`submit_work\`

## Chain Selection Guide

| Situation | Chain |
|-----------|-------|
| New task, full process | full-mill |
| Quick implementation | quick-mill |
| Requirements unclear | clarify → need_clarification |
| After human answered | resume-from-clarify |
| After human approved plan | resume-from-plan |
| After review feedback | resume-from-review |

## Rules

- Always use a chain for implementation (don't implement directly)
- Use \`clarify\` chain before \`need_clarification\` tool
- Run tests before submitting
- Keep human buddy informed of progress`,
    };
  });
}
