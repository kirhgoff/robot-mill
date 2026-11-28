import { beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./http";
import { createLinearTracker } from "./linear";
import { createLinearWebhook } from "./linear-webhook";
import { createLogNotifier } from "./notifier";
import { openStore, type Store } from "./store";
import { createTasks } from "./tasks";
import { FakeTmux } from "./tmux.fake";
import { createGit } from "./worktree";

type Sent = { query: string; variables: Record<string, any> };

let sent: Sent[];

const bootstrap = {
  viewer: { id: "viewer-1" },
  teams: {
    nodes: [
      {
        id: "team-1",
        states: { nodes: ["Agent Queue", "In Progress", "In Review", "Agent Failed", "Done", "Canceled"].map((name) => ({ id: `state-${name}`, name })) },
        projects: { nodes: [{ id: "proj-1", name: "robot-mill" }, { id: "proj-2", name: "toni" }] },
      },
    ],
  },
};

const fakeFetch = async (_url: string, init: { body: string }) => {
  const request = JSON.parse(init.body) as Sent;
  sent.push(request);
  const data = request.query.includes("viewer")
    ? bootstrap
    : request.query.includes("issueCreate")
      ? { issueCreate: { issue: { identifier: "KIR-9", url: "https://linear.app/x/KIR-9" } } }
      : request.query.includes("issue(id")
        ? { issue: { id: "uuid-9" } }
        : {};
  return { json: async () => ({ data }) };
};

const linear = () => createLinearTracker({ apiKey: "key", fetch: fakeFetch });

beforeEach(() => {
  sent = [];
});

test("create sends the Agent Queue state, viewer assignee and project ids and returns identifier and url", async () => {
  const created = await linear().create({ title: "T", description: "D", project: "toni" });
  expect(created).toEqual({ id: "KIR-9", url: "https://linear.app/x/KIR-9" });
  expect(sent.find((s) => s.query.includes("issueCreate"))?.variables.input).toEqual({
    teamId: "team-1",
    title: "T",
    description: "D",
    projectId: "proj-2",
    assigneeId: "viewer-1",
    stateId: "state-Agent Queue",
  });
});

test("create with an unknown project lists the valid names", async () => {
  await expect(linear().create({ title: "T", description: "D", project: "nope" })).rejects.toThrow("valid projects: robot-mill, toni");
});

test("move and comment address the issue by identifier and resolved ids", async () => {
  const tracker = linear();
  await tracker.move("KIR-9", "Agent Failed");
  await tracker.comment("KIR-9", "boom");
  expect(sent.find((s) => s.query.includes("issueUpdate"))?.variables).toEqual({ id: "KIR-9", input: { stateId: "state-Agent Failed" } });
  expect(sent.find((s) => s.query.includes("commentCreate"))?.variables.input).toEqual({ issueId: "uuid-9", body: "boom" });
});

test("a failed task moves its ticket to Agent Failed with a comment", async () => {
  const store = openStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "mill-"));
  const tasks = createTasks({
    store,
    tmux: new FakeTmux(),
    git: createGit(root, async () => ({ code: 0, stdout: "" })),
    tracker: linear(),
    notifier: createLogNotifier(),
    pool: ["claude"],
    sessionsDir: join(root, "sessions"),
    baseUrl: () => "http://x",
    hookCommand: ["hook"],
    checkRepo: async () => {},
  });
  const task = store.insertTask({ kind: "build", title: "T", ticket_id: "KIR-9", state: "running" });
  await tasks.complete(task, { failure: "no repo" });
  expect(sent.find((s) => s.query.includes("issueUpdate"))?.variables.input.stateId).toBe("state-Agent Failed");
  expect(sent.find((s) => s.query.includes("commentCreate"))?.variables.input.body).toBe("no repo");
});

const secret = "shh";
const now = 1_000_000;
let store: Store;
let server: ReturnType<typeof startServer>;

function post(body: object, options: { signature?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify({ webhookTimestamp: options.timestamp ?? now, ...body });
  const signature = options.signature ?? createHmac("sha256", secret).update(raw).digest("hex");
  return fetch(`http://127.0.0.1:${server.port}/linear`, { method: "POST", headers: { "linear-signature": signature }, body: raw });
}

const move = (state: string, extra: object = {}, identifier = "KIR-20") => ({
  type: "Issue",
  action: "update",
  url: "https://linear.app/x/KIR-20",
  updatedFrom: { stateId: "old" },
  data: { identifier, title: "Do it", description: "details", state: { name: state }, project: { name: "toni" }, labels: [], ...extra },
});

function startWebhook(withSecret = true) {
  store = openStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "mill-"));
  const tasks = createTasks({
    store,
    tmux: new FakeTmux(),
    git: createGit(root, async () => ({ code: 0, stdout: "" })),
    tracker: linear(),
    notifier: createLogNotifier(),
    pool: [],
    sessionsDir: join(root, "sessions"),
    baseUrl: () => "http://x",
    hookCommand: ["hook"],
    checkRepo: async () => {},
  });
  const webhook = withSecret ? createLinearWebhook({ secret, store, tasks, now: () => now }) : undefined;
  server = startServer(0, tasks, undefined, webhook);
}

test("webhook rejects a bad signature and a stale timestamp and queues nothing", async () => {
  startWebhook();
  expect((await post(move("Agent Queue"), { signature: "00".repeat(32) })).status).toBe(401);
  expect((await post(move("Agent Queue"), { timestamp: now - 61_000 })).status).toBe(401);
  expect(store.listTasks()).toHaveLength(0);
  server.stop(true);
});

test("webhook queues one build task for a move into Agent Queue and ignores the same ticket twice", async () => {
  startWebhook();
  expect((await post(move("Agent Queue"))).status).toBe(200);
  expect((await post(move("Agent Queue"))).status).toBe(200);
  expect(store.listTasks()).toHaveLength(1);
  expect(store.listTasks()[0]).toMatchObject({ kind: "build", title: "Do it", description: "details", linear_project: "toni", ticket_id: "KIR-20", ticket_url: "https://linear.app/x/KIR-20" });
  server.stop(true);
});

test("webhook ignores create events and moves into other states", async () => {
  startWebhook();
  await post({ ...move("Agent Queue"), action: "create" });
  await post(move("In Progress", {}, "KIR-21"));
  expect(store.listTasks()).toHaveLength(0);
  server.stop(true);
});

test("a worker:codex label pins the task", async () => {
  startWebhook();
  await post(move("Agent Queue", { labels: [{ name: "bug" }, { name: "worker:codex" }] }));
  expect(store.listTasks()[0]?.pinned_type).toBe("codex");
  server.stop(true);
});

test("the /linear route is 404 without a secret", async () => {
  startWebhook(false);
  expect((await post(move("Agent Queue"))).status).toBe(404);
  server.stop(true);
});
