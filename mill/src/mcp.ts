import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Tasks } from "./tasks";

const dispatcherSession = "mill-dispatcher";

const worker = z.enum(["claude", "codex"]);
const repoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((name) => name !== "." && name !== "..");

async function respond(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function createMcpServer(tasks: Tasks, session: string) {
  const server = new McpServer({ name: "mill", version: "0.1.0" });
  const isDispatcher = session === dispatcherSession;

  function taskFor(id: string) {
    const task = tasks.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    if (!isDispatcher && task.session !== session) throw new Error(`task ${id} does not belong to ${session}`);
    return task;
  }

  server.registerTool(
    "send_message",
    { description: "Send a message to Kirill on Telegram", inputSchema: { text: z.string(), task: z.string().optional() } },
    ({ text, task }) => respond(async () => ({ message_id: await tasks.message(text, task ? taskFor(task) : undefined) })),
  );
  server.registerTool(
    "ask_question",
    { description: "Ask Kirill a question; his reply is typed into your session", inputSchema: { task: z.string(), text: z.string() } },
    ({ task, text }) => respond(async () => ({ message_id: await tasks.ask(taskFor(task), text) })),
  );

  if (isDispatcher) {
    server.registerTool(
      "submit_task",
      {
        description: "File a ticket and queue a build task",
        inputSchema: { title: z.string(), description: z.string(), linear_project: z.string(), worker: worker.optional() },
      },
      (input) => respond(() => tasks.submit(input)),
    );
    server.registerTool("list_tasks", { description: "List every task" }, () => respond(async () => tasks.list()));
    server.registerTool(
      "task_status",
      { description: "Show one task", inputSchema: { id: z.string() } },
      ({ id }) => respond(async () => taskFor(id)),
    );
    server.registerTool(
      "answer",
      { description: "Type text into a task's session", inputSchema: { task: z.string(), text: z.string() } },
      ({ task, text }) => respond(async () => tasks.answer(taskFor(task), text).then(() => "sent")),
    );
    server.registerTool(
      "stop_task",
      { description: "Kill a task's session and fail its ticket", inputSchema: { task: z.string() } },
      ({ task }) => respond(async () => tasks.stop(taskFor(task)).then(() => "stopped")),
    );
  } else {
    server.registerTool(
      "prepare_worktree",
      { description: "Clone or fetch the repo and create your worktree; returns its path", inputSchema: { repo: repoName } },
      ({ repo }) =>
        respond(async () => {
          const task = tasks.activeFor(session);
          if (!task) throw new Error(`no active task for ${session}`);
          return { path: await tasks.prepareWorktree(task, repo) };
        }),
    );
    server.registerTool(
      "complete_task",
      {
        description: "Report the PR you opened, or the reason you failed",
        inputSchema: { task: z.string(), pr_url: z.string().optional(), failure: z.string().optional() },
      },
      ({ task, pr_url, failure }) => respond(async () => tasks.complete(taskFor(task), { pr_url, failure }).then(() => "recorded")),
    );
  }

  return server;
}
