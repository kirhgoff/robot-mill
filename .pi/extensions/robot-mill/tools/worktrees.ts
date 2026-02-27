/**
 * Robot Mill — Git Worktree Tools
 * 
 * Tools:
 * - worktree_list: List all worktrees
 * - worktree_create: Create worktree for a task
 * - worktree_enter: Enter a task's worktree
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RobotState } from "../types.ts";
import { listAllWorktrees, createWorktree } from "../helpers/git.ts";
import { readTask, writeTask } from "./tasks.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const WorktreeListSchema = Type.Object({});

const WorktreeCreateSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to create worktree for" }),
  repository: Type.Optional(
    Type.String({
      description: "Repository (GitHub: 'owner/repo', or local path). If not provided, reads from task.",
    })
  ),
  branch: Type.Optional(Type.String({ description: "Branch name (auto-generated if not provided)" })),
});

const WorktreeEnterSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to enter worktree for" }),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function registerWorktreeTools(pi: ExtensionAPI, state: RobotState): void {
  // ─────────────────────────────────────────────────────────────────────────────
  // worktree_list
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_list",
    description: "List all git worktrees. Each worktree can be working on a separate task in parallel.",
    parameters: WorktreeListSchema,

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const worktrees = await listAllWorktrees(state, ctx.cwd);

      if (worktrees.length === 0) {
        return {
          content: [{ type: "text", text: "No worktrees found" }],
          details: { worktrees: [] },
        };
      }

      const summary = worktrees
        .map((w) => `${w.isMain ? "★" : "○"} ${w.branch} → ${w.path}${w.taskId ? ` (task: ${w.taskId})` : ""}`)
        .join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { worktrees },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // worktree_create
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_create",
    description:
      "Create a new git worktree for a task. Clones the repository if needed (supports GitHub 'owner/repo' format). Each task gets its own directory with its own branch.",
    parameters: WorktreeCreateSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        // Get repository and title from params or task
        let repository = params.repository;
        let taskTitle: string | undefined;
        const task = await readTask(state, ctx.cwd, params.taskId);

        if (task) {
          if (!repository) repository = task.repository;
          taskTitle = task.title;
        }

        if (!repository) {
          return {
            content: [
              {
                type: "text",
                text: `Error: No repository specified and task ${params.taskId} has no repository set`,
              },
            ],
            isError: true,
          };
        }

        const worktree = await createWorktree(
          params.taskId,
          repository,
          state,
          ctx.cwd,
          params.branch,
          taskTitle
        );

        // Update task with branch name
        if (task && !task.branch) {
          task.branch = worktree.branch;
          await writeTask(state, ctx.cwd, task);
        }

        state.currentWorktree = worktree.path;

        return {
          content: [
            {
              type: "text",
              text: `✓ Created worktree for ${params.taskId}\n  Repository: ${repository}\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}`,
            },
          ],
          details: { worktree },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error creating worktree: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // worktree_enter
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_enter",
    description:
      "Set the current working directory to a task's worktree. All subsequent file operations will be in this worktree.",
    parameters: WorktreeEnterSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const worktrees = await listAllWorktrees(state, ctx.cwd);
      const worktree = worktrees.find((w) => w.taskId === params.taskId);

      if (!worktree) {
        return {
          content: [
            {
              type: "text",
              text: `No worktree found for task: ${params.taskId}. Create one first with worktree_create.`,
            },
          ],
          isError: true,
        };
      }

      state.currentWorktree = worktree.path;
      process.chdir(worktree.path);

      return {
        content: [
          {
            type: "text",
            text: `✓ Entered worktree for ${params.taskId}\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}`,
          },
        ],
        details: { worktree },
      };
    },
  });
}
