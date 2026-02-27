/**
 * Robot Mill — High-Level Workflow Tool
 * 
 * Tools:
 * - workflow: next, status, finish
 * 
 * This orchestrates the task lifecycle:
 * - next: Pick up next available task, create worktree, start working
 * - status: Show current workflow status
 * - finish: Commit changes, push, submit for review
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "child_process";
import { promisify } from "util";
import type { RobotState } from "../types.ts";
import { git } from "../helpers/git.ts";
import { createWorktree, listAllWorktrees } from "../helpers/git.ts";
import { readTask, writeTask, listTasks } from "./tasks.ts";
import { updateWidget } from "../ui/widget.ts";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const WorkflowSchema = Type.Object({
  action: Type.Union([
    Type.Literal("next"),    // Pick next available task
    Type.Literal("status"),  // Show current workflow status
    Type.Literal("finish"),  // Finish current task (commit, push, submit for review)
  ]),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function registerWorkflowTools(pi: ExtensionAPI, state: RobotState): void {
  pi.registerTool({
    name: "workflow",
    description: `High-level workflow commands:
- next: Pick up the next available task, create worktree, start working
- status: Show current workflow status
- finish: Commit changes, push, submit for review`,
    parameters: WorkflowSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        // ─────────────────────────────────────────────────────────────────────
        // NEXT: Pick up next task
        // ─────────────────────────────────────────────────────────────────────
        case "next": {
          // Find available task
          const tasks = await listTasks(state, ctx.cwd, "todo");
          if (tasks.length === 0) {
            return {
              content: [{ type: "text", text: "No available tasks. All caught up! 🎉" }],
            };
          }

          const task = tasks[0];

          if (!task.repository) {
            return {
              content: [{ type: "text", text: `Error: Task ${task.id} has no repository specified` }],
              isError: true,
            };
          }

          // Start working
          task.status = "in_progress";
          task.assignee = "robot";
          await writeTask(state, ctx.cwd, task);
          state.currentTaskId = task.id;

          // Create worktree with task title for meaningful branch name
          const worktree = await createWorktree(
            task.id,
            task.repository,
            state,
            ctx.cwd,
            undefined, // auto-generate branch
            task.title // pass title for slug
          );
          task.branch = worktree.branch;
          await writeTask(state, ctx.cwd, task);

          // Enter worktree
          state.currentWorktree = worktree.path;
          process.chdir(worktree.path);

          // Update widget
          updateWidget();

          return {
            content: [
              {
                type: "text",
                text: `
🤖 Starting task: ${task.title}

**Task ID:** ${task.id}
**Repository:** ${task.repository}
**Worktree:** ${worktree.path}
**Branch:** ${worktree.branch}

## Description

${task.description}

---

## Next Steps

Now use \`run_mill\` to execute a workflow chain:

| Chain | When to Use |
|-------|-------------|
| \`full-mill\` | Complete workflow (understand → plan → build → test → review) |
| \`quick-mill\` | Fast implementation (understand → plan → build) |
| \`clarify\` | If requirements are unclear |
| \`plan-only\` | Just create a plan for review |

Example: \`run_mill chain="full-mill"\`
`,
              },
            ],
            details: { task, worktree },
          };
        }

        // ─────────────────────────────────────────────────────────────────────
        // STATUS: Show current workflow status
        // ─────────────────────────────────────────────────────────────────────
        case "status": {
          const worktrees = await listAllWorktrees(state, ctx.cwd);
          const activeTasks = await listTasks(state, ctx.cwd, "in_progress");

          const { execution } = state;
          let executionStatus = "";
          if (execution.status !== "idle") {
            executionStatus = `
**Current Execution:**
- Chain: ${execution.chainName}
- Step: ${execution.currentStep + 1}/${execution.steps.length}
- Status: ${execution.status}
`;
          }

          return {
            content: [
              {
                type: "text",
                text: `
## Workflow Status

**Current Task:** ${state.currentTaskId || "(none)"}
**Current Worktree:** ${state.currentWorktree || "(main)"}
${executionStatus}
**Active Tasks:** ${activeTasks.length}
${activeTasks.map((t) => `  - ${t.id}: ${t.title}`).join("\n")}

**Worktrees:** ${worktrees.length}
${worktrees.map((w) => `  - ${w.branch}${w.taskId ? ` (${w.taskId})` : ""}`).join("\n")}
`,
              },
            ],
          };
        }

        // ─────────────────────────────────────────────────────────────────────
        // FINISH: Complete current task
        // ─────────────────────────────────────────────────────────────────────
        case "finish": {
          if (!state.currentTaskId) {
            return {
              content: [{ type: "text", text: "No active task. Use `workflow next` to pick one up." }],
              isError: true,
            };
          }

          const task = await readTask(state, ctx.cwd, state.currentTaskId);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task not found: ${state.currentTaskId}` }],
              isError: true,
            };
          }

          const cwd = state.currentWorktree || process.cwd();

          // Check for changes
          const status = await git("status --porcelain", cwd);
          if (status) {
            // Commit changes
            await git("add -A", cwd);
            await git(`commit -m "feat(${task.id}): ${task.title}"`, cwd);
          }

          // Push and capture output
          const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
          let pushOutput = "";
          try {
            const { stderr } = await execAsync(`git push -u origin ${branch}`, { cwd });
            pushOutput = stderr; // Git push messages go to stderr
          } catch (err: any) {
            pushOutput = err.stderr || err.message || "";
          }

          // Update task status
          task.status = "in_review";
          task.assignee = task.humanBuddy;
          task.notes.push({
            timestamp: new Date().toISOString(),
            author: "robot",
            type: "progress",
            content: `Implementation complete. Branch: ${branch}`,
          });
          await writeTask(state, ctx.cwd, task);

          state.currentTaskId = null;

          // Extract PR creation link from push output
          let prMessage = "";
          const prLinkMatch = pushOutput.match(
            /Create a pull request for '[^']+' on GitHub by visiting:\s*(https:\/\/[^\s]+)/
          );
          if (prLinkMatch) {
            prMessage = `\n🔗 **PR Creation Link:** ${prLinkMatch[1]}`;
          }

          // Update widget
          updateWidget();

          return {
            content: [
              {
                type: "text",
                text: `
✓ Task ${task.id} submitted for review!

**Branch:** ${branch}
**Assigned to:** ${task.humanBuddy}${prMessage}

The task is now in "in_review" status. Your human buddy will review the changes.

${prMessage ? "Use the PR link above to create a pull request." : `Branch "${branch}" is ready for PR creation.`}

Use \`workflow next\` to pick up another task.
`,
              },
            ],
            details: { task, branch, prLink: prLinkMatch?.[1] },
          };
        }
      }
    },
  });
}
