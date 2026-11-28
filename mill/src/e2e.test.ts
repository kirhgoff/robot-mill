import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "./http";
import { createLogNotifier } from "./notifier";
import { openStore } from "./store";
import { createTasks } from "./tasks";
import { FakeTmux } from "./tmux.fake";
import { createLogTracker } from "./tracker";
import { createGit } from "./worktree";

let server: ReturnType<typeof startServer>;
let tmux: FakeTmux;
let commands: string[][];
let tasks: ReturnType<typeof createTasks>;
let projects: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "mill-"));
  projects = join(root, "projects");
  tmux = new FakeTmux();
  commands = [];
  tasks = createTasks({
    store: openStore(":memory:"),
    tmux,
    git: createGit(projects, async (argv) => {
      commands.push(argv);
      return { code: 0, stdout: "" };
    }),
    tracker: createLogTracker(),
    notifier: createLogNotifier(),
    pool: ["claude", "codex"],
    sessionsDir: join(root, "sessions"),
    baseUrl: () => `http://127.0.0.1:${server.port}`,
    hookCommand: ["mill-hook"],
    checkRepo: async () => {},
  });
  server = startServer(0, tasks);
});

afterEach(() => server.stop(true));

async function connect(session: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp?session=${session}`)));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { isError: Boolean(result.isError), text };
}

test("a task goes from submit to pr_open and queues a review on the other type", async () => {
  const dispatcher = await connect("mill-dispatcher");
  const submitted = await call(dispatcher, "submit_task", { title: "Add Widget!", description: "do it", linear_project: "proj" });
  expect(JSON.parse(submitted.text)).toMatchObject({ id: "t1", ticket_id: "LOCAL-1" });

  const build = tasks.get("t1");
  expect(build).toMatchObject({ state: "running", session: "mill-t1" });
  const builderType = build?.agent_type ?? undefined;
  expect(tmux.sessions.get("mill-t1")?.argv[0]).toBe(builderType);
  expect(tmux.sent.has("mill-t1")).toBe(false);
  expect(tmux.sessions.get("mill-t1")?.argv.at(-1)).toContain("LOCAL-1");

  const worker = await connect("mill-t1");
  const prepared = await call(worker, "prepare_worktree", { repo: "widgets" });
  expect(JSON.parse(prepared.text).path).toBe(join(projects, "widgets-local-1-add-widget"));
  expect(commands.map((argv) => argv.slice(0, 3).join(" "))).toEqual(["gh repo clone", "git worktree add"]);

  const completed = await call(worker, "complete_task", { task: "t1", pr_url: "https://github.com/kirhgoff/widgets/pull/1" });
  expect(completed.isError).toBe(false);

  expect(tasks.get("t1")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/kirhgoff/widgets/pull/1" });
  const review = tasks.get("t2");
  expect(review).toMatchObject({ kind: "review", parent: "t1", state: "running" });
  expect(review?.agent_type).not.toBe(builderType);
  expect(tmux.sessions.get("mill-t2")?.argv.at(-1)).toContain("pull/1");
});

test("a worker cannot call dispatcher tools", async () => {
  const worker = await connect("mill-t1");
  const tools = (await worker.listTools()).tools.map((tool) => tool.name);
  expect(tools).not.toContain("submit_task");
  expect(tools).not.toContain("stop_task");
  expect(tools).toContain("complete_task");
  const refused = await call(worker, "submit_task", { title: "x", description: "y", linear_project: "z" });
  expect(refused.isError).toBe(true);
});

test("the dispatcher has no worker tools", async () => {
  const tools = (await (await connect("mill-dispatcher")).listTools()).tools.map((tool) => tool.name);
  expect(tools).not.toContain("complete_task");
  expect(tools).not.toContain("prepare_worktree");
});

test("a worker naming another task is refused", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p" });
  await tasks.submit({ title: "B", description: "", linear_project: "p" });
  const worker = await connect("mill-t1");
  const refused = await call(worker, "complete_task", { task: "t2", failure: "nope" });
  expect(refused).toMatchObject({ isError: true });
  expect(refused.text).toContain("does not belong");
  expect(tasks.get("t2")?.state).toBe("running");
});

test("a failed task moves to failed and frees its slot for the queue", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p", worker: "claude" });
  await tasks.submit({ title: "B", description: "", linear_project: "p", worker: "claude" });
  expect(tasks.get("t2")?.state).toBe("queued");
  const worker = await connect("mill-t1");
  await call(worker, "complete_task", { task: "t1", failure: "broke" });
  expect(tasks.get("t1")).toMatchObject({ state: "failed", failure: "broke" });
  expect(tasks.get("t2")?.state).toBe("running");
});

test("stop_task kills the session and cancels the task", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p" });
  const dispatcher = await connect("mill-dispatcher");
  await call(dispatcher, "stop_task", { task: "t1" });
  expect(tasks.get("t1")?.state).toBe("canceled");
  expect(tmux.sessions.has("mill-t1")).toBe(false);
});

test("ask_question waits for an answer that is typed into the session", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p" });
  const worker = await connect("mill-t1");
  await call(worker, "ask_question", { task: "t1", text: "which db?" });
  expect(tasks.get("t1")?.state).toBe("waiting_answer");
  await call(await connect("mill-dispatcher"), "answer", { task: "t1", text: "postgres" });
  expect(tasks.get("t1")?.state).toBe("running");
  expect(tmux.sent.get("mill-t1")?.at(-1)).toBe("postgres");
});

test("a fix task reuses the parent's session and type", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p" });
  await call(await connect("mill-t1"), "complete_task", { task: "t1", pr_url: "https://x/pull/1" });
  const parentType = tasks.get("t1")?.agent_type;
  const fix = await tasks.queueFix("t1");
  expect(tasks.get(fix.id)).toMatchObject({ kind: "fix", state: "running", session: "mill-t1", agent_type: parentType });
  expect(tmux.sent.get("mill-t1")?.at(-1)).toContain("RESOLVED in <sha>");
});

test("the turn-end hook records the codex thread id", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p", worker: "codex" });
  await fetch(`http://127.0.0.1:${server.port}/hook/turn-end?session=mill-t1`, { method: "POST", body: JSON.stringify({ "thread-id": "th-1" }) });
  expect(tasks.get("t1")?.conversation_id).toBe("th-1");
});

test("unknown paths are 404", async () => {
  expect((await fetch(`http://127.0.0.1:${server.port}/other?session=x`)).status).toBe(404);
});

test("a codex thread id arriving during a fix round is used to resume the next fix", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p", worker: "codex" });
  await call(await connect("mill-t1"), "complete_task", { task: "t1", pr_url: "https://x/pull/1" });
  await tasks.queueFix("t1");
  await fetch(`http://127.0.0.1:${server.port}/hook/turn-end?session=mill-t1`, { method: "POST", body: JSON.stringify({ "thread-id": "th-7" }) });
  expect(tasks.get("t1")?.conversation_id).toBe("th-7");
  tmux.sessions.delete("mill-t1");
  await call(await connect("mill-t1"), "complete_task", { task: "t3", pr_url: "https://x/pull/1" });
  await tasks.queueFix("t1");
  expect(tmux.sessions.get("mill-t1")?.argv.slice(0, 3)).toEqual(["codex", "resume", "th-7"]);
});

test("prepare_worktree refuses repo names that are not plain names", async () => {
  await tasks.submit({ title: "A", description: "", linear_project: "p" });
  const worker = await connect("mill-t1");
  for (const repo of ["kirhgoff/foo", "../x", "..", "."]) {
    expect((await call(worker, "prepare_worktree", { repo })).isError).toBe(true);
  }
  expect(commands).toEqual([]);
});
