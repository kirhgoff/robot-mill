import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearIssue } from "./linear";
import type { Notifier } from "./notifier";
import { createRecover, type PrView } from "./recover";
import { openStore, type AgentType, type Store } from "./store";
import { createTasks, restartMessage } from "./tasks";
import { FakeTmux } from "./tmux.fake";
import type { Tracker } from "./tracker";
import { createGit } from "./worktree";

const prUrl = "https://github.com/kirhgoff/widgets/pull/1";
const limitText = "You've hit your limit · resets 3pm (America/New_York)";

let root: string;
let clock: number;
let tmux: FakeTmux;
let sent: string[];
let moves: string[];
let timers: { fn: () => void; ms: number }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mill-"));
  clock = Date.parse("2026-11-28T10:00:00Z");
  tmux = new FakeTmux();
  sent = [];
  moves = [];
  timers = [];
});

function farm(store: Store, pool: AgentType[] = ["claude", "codex"]) {
  const notifier: Notifier = { send: async (text) => sent.push(text), ask: async () => 1 };
  let tickets = 0;
  const tracker: Tracker = {
    create: async () => ({ id: `KIR-${++tickets}`, url: `https://linear.app/KIR-${tickets}` }),
    move: async (id, state) => void moves.push(`${id} ${state}`),
    comment: async () => {},
  };
  return createTasks({
    store,
    tmux,
    git: createGit(join(root, "projects"), async () => ({ code: 0, stdout: "" })),
    tracker,
    notifier,
    pool,
    sessionsDir: join(root, "sessions"),
    baseUrl: () => "http://127.0.0.1:1",
    hookCommand: ["mill-hook"],
    checkRepo: async () => {},
    postReview: async () => {},
    now: () => clock,
    schedule: (fn, ms) => void timers.push({ fn, ms }),
  });
}

const submit = (tasks: ReturnType<typeof farm>, worker?: AgentType) => tasks.submit({ title: "Widget", description: "", linear_project: "p", worker });
const nudgeText = () => (tmux.sent.get("mill-t1") ?? []).filter((text) => text.startsWith("Call complete_task"));

test("a silent turn gets a nudge, the next one a Telegram message, and a signal clears it", async () => {
  const tasks = farm(openStore(":memory:"));
  await submit(tasks);
  await tasks.onTurnEnd("mill-t1", {});
  expect(nudgeText()).toHaveLength(1);
  expect(sent).toEqual([]);

  await tasks.onTurnEnd("mill-t1", {});
  expect(sent).toEqual(["worker idle on KIR-1: tmux attach -t mill-t1"]);
  expect(nudgeText()).toHaveLength(1);

  await tasks.onTurnEnd("mill-t1", {});
  expect(sent).toHaveLength(1);

  clock += 10;
  await tasks.message("progress", tasks.get("t1")!);
  expect(tasks.get("t1")?.nudges).toBe(0);
  await tasks.onTurnEnd("mill-t1", {});
  expect(nudgeText()).toHaveLength(1);
  expect(sent).toHaveLength(2);
});

test("a turn after a signal is not nudged, and a new prompt makes the next silent turn nudgeable", async () => {
  const tasks = farm(openStore(":memory:"));
  await submit(tasks);
  clock += 10;
  await tasks.ask(tasks.get("t1")!, "which db?");
  await tasks.onTurnEnd("mill-t1", {});
  expect(nudgeText()).toHaveLength(0);

  clock += 10;
  await tasks.answer(tasks.get("t1")!, "postgres");
  await tasks.onTurnEnd("mill-t1", {});
  expect(nudgeText()).toHaveLength(1);
});

test("a limited turn pauses the task, blocks its type until the reset and resumes it then", async () => {
  const tasks = farm(openStore(":memory:"), ["claude", "claude", "codex"]);
  await submit(tasks, "claude");
  tmux.panes.set("mill-t1", limitText);
  await tasks.onTurnEnd("mill-t1", {});

  const resetAt = Date.parse("2026-11-28T20:00:00Z");
  expect(tasks.get("t1")).toMatchObject({ state: "paused_limit", reset_at: resetAt });
  expect(sent[0]).toContain("KIR-1: claude hit its limit, resets");
  expect(nudgeText()).toHaveLength(0);
  expect(timers.map((timer) => timer.ms)).toEqual([resetAt + 60_000 - clock]);

  await submit(tasks, "claude");
  await submit(tasks, "codex");
  expect(tasks.get("t2")?.state).toBe("queued");
  expect(tasks.get("t3")?.state).toBe("running");

  clock = resetAt + 60_000;
  timers[0]?.fn();
  await tasks.tick();
  expect(tasks.get("t1")?.state).toBe("running");
  expect(tmux.sent.get("mill-t1")?.at(-1)).toBe("continue");
  expect(tasks.get("t2")?.state).toBe("running");
});

test("an unreadable reset time pauses for an hour and says so", async () => {
  const tasks = farm(openStore(":memory:"));
  await submit(tasks, "claude");
  tmux.panes.set("mill-t1", "You've hit your limit · resets whenever");
  await tasks.onTurnEnd("mill-t1", {});
  expect(tasks.get("t1")?.reset_at).toBe(clock + 3_600_000);
  expect(sent[0]).toContain("assuming 1 hour");
});

test("a reboot resumes every in-flight task by conversation id", async () => {
  const dbPath = join(root, "mill.db");
  const before = farm(openStore(dbPath), ["claude", "codex", "claude"]);
  await submit(before, "claude");
  await submit(before, "codex");
  await submit(before, "claude");
  await before.onTurnEnd("mill-t2", { "thread-id": "th-1" });
  await before.ask(before.get("t3")!, "which db?");
  const claudeId = before.get("t1")?.conversation_id as string;
  const waitingId = before.get("t3")?.conversation_id as string;
  expect(before.get("t3")?.state).toBe("waiting_answer");

  tmux = new FakeTmux();
  const after = farm(openStore(dbPath), ["claude", "codex", "claude"]);
  await createRecover({ tasks: after, tmux, viewPr: async () => openPr, botLogins: [] })();

  const argv = (name: string) => tmux.sessions.get(name)?.argv ?? [];
  expect(argv("mill-t1").slice(0, 3)).toEqual(["claude", "--resume", claudeId]);
  expect(argv("mill-t1").at(-1)).toBe(restartMessage);
  expect(argv("mill-t2").slice(0, 3)).toEqual(["codex", "resume", "th-1"]);
  expect(argv("mill-t2").at(-1)).toBe(restartMessage);
  expect(argv("mill-t3").slice(0, 3)).toEqual(["claude", "--resume", waitingId]);
  expect(after.list().map((task) => task.state)).toEqual(["running", "running", "waiting_answer"]);
});

test("a codex task with no thread id yet is relaunched fresh with its original prompt", async () => {
  const store = openStore(":memory:");
  await submit(farm(store), "codex");
  tmux = new FakeTmux();
  await createRecover({ tasks: farm(store), tmux, viewPr: async () => openPr, botLogins: [] })();
  const argv = tmux.sessions.get("mill-t1")?.argv ?? [];
  expect(argv[1]).not.toBe("resume");
  expect(argv.at(-1)).toContain("You are the worker for task t1");
});

test("a paused task is resumed silently on boot and continues at the reset", async () => {
  const store = openStore(":memory:");
  const before = farm(store);
  await submit(before, "claude");
  tmux.panes.set("mill-t1", limitText);
  await before.onTurnEnd("mill-t1", {});

  tmux = new FakeTmux();
  timers = [];
  const after = farm(store);
  await createRecover({ tasks: after, tmux, viewPr: async () => openPr, botLogins: [] })();
  const argv = tmux.sessions.get("mill-t1")?.argv ?? [];
  expect(argv[1]).toBe("--resume");
  expect(argv).not.toContain(restartMessage);
  expect(timers).toHaveLength(1);

  clock = (after.get("t1")?.reset_at as number) + 60_000;
  timers[0]?.fn();
  await after.tick();
  expect(after.get("t1")?.state).toBe("running");
  expect(tmux.sent.get("mill-t1")).toEqual(["continue"]);
});

const openPr: PrView = { state: "OPEN", reviews: [], comments: [] };
const at = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

async function withOpenPr() {
  const tasks = farm(openStore(":memory:"));
  await submit(tasks);
  clock += 1000;
  await tasks.complete(tasks.get("t1")!, { pr_url: prUrl });
  clock += 1000;
  return tasks;
}

const recoverWith = (tasks: ReturnType<typeof farm>, view: PrView) => createRecover({ tasks, tmux, viewPr: async () => view, botLogins: ["millwright", "mill-inspector[bot]"] })();

test("a merge missed while down closes the build", async () => {
  const tasks = await withOpenPr();
  await recoverWith(tasks, { ...openPr, state: "MERGED" });
  expect(tasks.get("t1")?.state).toBe("done");
  expect(moves).toContain("KIR-1 Done");
  expect(sent).toContain(`KIR-1: merged: ${prUrl}`);
});

test("a close missed while down cancels the build", async () => {
  const tasks = await withOpenPr();
  await recoverWith(tasks, { ...openPr, state: "CLOSED" });
  expect(tasks.get("t1")?.state).toBe("canceled");
  expect(moves).toContain("KIR-1 Canceled");
});

test("a human review missed while down queues one fix", async () => {
  const tasks = await withOpenPr();
  const view = { ...openPr, reviews: [{ author: { login: "kirhgoff" }, submittedAt: at(0) }] };
  await recoverWith(tasks, view);
  await recoverWith(tasks, view);
  expect(tasks.list().filter((task) => task.kind === "fix")).toHaveLength(1);
});

test("old activity and bot activity do not queue a fix", async () => {
  const tasks = await withOpenPr();
  await recoverWith(tasks, {
    ...openPr,
    reviews: [{ author: { login: "kirhgoff" }, submittedAt: at(-60_000) }],
    comments: [{ author: { login: "mill-inspector" }, createdAt: at(0) }, { author: { login: "millwright" }, createdAt: at(0) }],
  });
  expect(tasks.list().filter((task) => task.kind === "fix")).toHaveLength(0);
});

test("an Agent Queue ticket missed while down is queued once", async () => {
  const tasks = farm(openStore(":memory:"));
  const issue: LinearIssue = { identifier: "KIR-30", url: "https://linear.app/KIR-30", title: "Missed", description: "d", state: "Agent Queue", project: "toni", labels: ["worker:codex"] };
  const recover = createRecover({ tasks, tmux, viewPr: async () => openPr, agentQueue: async () => [issue], botLogins: [] });
  await recover();
  await recover();
  expect(tasks.list().filter((task) => task.ticket_id === "KIR-30")).toHaveLength(1);
  expect(tasks.get("t1")).toMatchObject({ pinned_type: "codex", state: "running" });
});
