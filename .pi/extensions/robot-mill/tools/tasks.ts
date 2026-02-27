/**
 * Robot Mill — Task Management Tools
 * 
 * Tools:
 * - task_list: List available tasks
 * - task_get: Get task details
 * - task_append: Add notes to a task
 * - task_status: Change task status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join, resolve } from "path";
import type { RobotState, Task, TaskNote, TaskStatus } from "../types.ts";
import { parseTaskMarkdown, serializeTask } from "../helpers/markdown.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getTasksDir(state: RobotState, cwd: string): string {
  return resolve(cwd, state.config.tasksDir);
}

async function readTask(state: RobotState, cwd: string, id: string): Promise<Task | null> {
  const filePath = join(getTasksDir(state, cwd), `${id}.md`);
  if (!existsSync(filePath)) return null;

  const content = await readFile(filePath, "utf-8");
  return parseTaskMarkdown(content, id);
}

async function writeTask(state: RobotState, cwd: string, task: Task): Promise<void> {
  const tasksDir = getTasksDir(state, cwd);
  await mkdir(tasksDir, { recursive: true });
  const filePath = join(tasksDir, `${task.id}.md`);
  await writeFile(filePath, serializeTask(task), "utf-8");
}

async function listTasks(state: RobotState, cwd: string, statusFilter?: string): Promise<Task[]> {
  const tasksDir = getTasksDir(state, cwd);
  if (!existsSync(tasksDir)) return [];

  const files = await readdir(tasksDir);
  const tasks: Task[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const id = file.slice(0, -3);
    const task = await readTask(state, cwd, id);
    if (task) {
      if (!statusFilter || statusFilter === "all" || task.status === statusFilter) {
        tasks.push(task);
      }
    }
  }

  return tasks.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const TaskListSchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("todo"),
      Type.Literal("in_progress"),
      Type.Literal("needs_info"),
      Type.Literal("in_review"),
      Type.Literal("done"),
      Type.Literal("all"),
    ])
  ),
});

const TaskGetSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
});

const TaskAppendSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
  type: Type.Union([
    Type.Literal("plan"),
    Type.Literal("question"),
    Type.Literal("answer"),
    Type.Literal("progress"),
    Type.Literal("review"),
    Type.Literal("general"),
  ]),
  content: Type.String({ description: "Content to append" }),
});

const TaskStatusSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
  action: Type.Union([
    Type.Literal("start_working"),
    Type.Literal("need_info"),
    Type.Literal("need_review"),
    Type.Literal("complete"),
  ]),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function registerTaskTools(pi: ExtensionAPI, state: RobotState): void {
  // ─────────────────────────────────────────────────────────────────────────────
  // task_list
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_list",
    description:
      "List available tasks. By default shows only 'todo' tasks (available for robot to pick up). Use status='all' to see all tasks.",
    parameters: TaskListSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const tasks = await listTasks(state, ctx.cwd, params.status || "todo");

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: `No tasks found with status: ${params.status || "todo"}` }],
          details: { tasks: [] },
        };
      }

      const summary = tasks
        .map((t) => `[${t.status}] ${t.id}: ${t.title} (buddy: ${t.humanBuddy}, repo: ${t.repository})`)
        .join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { tasks },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // task_get
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_get",
    description: "Get full details of a specific task including description, plan, questions, and all notes.",
    parameters: TaskGetSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = await readTask(state, ctx.cwd, params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      const output = [
        `# ${task.title}`,
        ``,
        `- **ID:** ${task.id}`,
        `- **Status:** ${task.status}`,
        `- **Human Buddy:** ${task.humanBuddy}`,
        `- **Repository:** ${task.repository}`,
        `- **Branch:** ${task.branch || "(not set)"}`,
        `- **Assignee:** ${task.assignee || "(unassigned)"}`,
        ``,
        `## Description`,
        ``,
        task.description,
        ``,
        `## Notes (${task.notes.length})`,
        ...task.notes.map((n) => `\n### ${n.timestamp} - ${n.author} - ${n.type}\n\n${n.content}`),
      ].join("\n");

      return {
        content: [{ type: "text", text: output }],
        details: { task },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // task_append
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_append",
    description:
      "Append a note to a task. Use type='plan' for implementation plans, 'question' for clarifying questions, 'progress' for status updates.",
    parameters: TaskAppendSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = await readTask(state, ctx.cwd, params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      task.notes.push({
        timestamp: new Date().toISOString(),
        author: "robot",
        type: params.type,
        content: params.content,
      });

      if (params.type === "plan") task.plan = params.content;

      await writeTask(state, ctx.cwd, task);

      return {
        content: [{ type: "text", text: `✓ Appended ${params.type} note to ${task.id}` }],
        details: { task },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // task_status
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_status",
    description: `Change task status:
- start_working: Begin work (status → in_progress, assignee → robot)
- need_info: Need clarification (status → needs_info, assignee → humanBuddy)
- need_review: Ready for review (status → in_review, assignee → humanBuddy)
- complete: Mark done (status → done)`,
    parameters: TaskStatusSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = await readTask(state, ctx.cwd, params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      const oldStatus = task.status;

      switch (params.action) {
        case "start_working":
          task.status = "in_progress";
          task.assignee = "robot";
          state.currentTaskId = task.id;
          break;
        case "need_info":
          task.status = "needs_info";
          task.assignee = task.humanBuddy;
          state.currentTaskId = null;
          break;
        case "need_review":
          task.status = "in_review";
          task.assignee = task.humanBuddy;
          state.currentTaskId = null;
          break;
        case "complete":
          task.status = "done";
          task.assignee = undefined;
          state.currentTaskId = null;
          break;
      }

      await writeTask(state, ctx.cwd, task);

      return {
        content: [{ type: "text", text: `✓ Task ${task.id}: ${oldStatus} → ${task.status}` }],
        details: { task, oldStatus, newStatus: task.status },
      };
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (for use by other modules)
// ═══════════════════════════════════════════════════════════════════════════════

export { readTask, writeTask, listTasks, getTasksDir };
