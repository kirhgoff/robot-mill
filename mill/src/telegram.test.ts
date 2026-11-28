import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, dispatcherSession } from "./dispatcher";
import { openStore, type Store } from "./store";
import { createTasks } from "./tasks";
import { createBot, createTelegramApi, createTelegramNotifier } from "./telegram";
import { FakeTmux } from "./tmux.fake";
import { createLogNotifier } from "./notifier";
import { createLogTracker } from "./tracker";
import { createGit } from "./worktree";

type Call = { method: string; body: Record<string, unknown> };

let calls: Call[];
let updates: unknown[];
let tmux: FakeTmux;
let store: Store;
let nextMessageId: number;

const fakeFetch = async (url: string, init: { body: string }) => {
  const method = url.split("/").at(-1) as string;
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === "getUpdates") return { json: async () => ({ ok: true, result: updates.splice(0) }) };
  nextMessageId += 1;
  return { json: async () => ({ ok: true, result: { message_id: nextMessageId } }) };
};

const api = () => createTelegramApi({ token: "t", chatId: "42", fetch: fakeFetch });
const sent = () => calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
const incoming = (id: number, text: string, chat = 42, replyTo?: number) => ({
  update_id: id,
  message: { message_id: 100 + id, chat: { id: chat }, text, ...(replyTo && { reply_to_message: { message_id: replyTo } }) },
});

function setup(sharedStore = store) {
  const root = mkdtempSync(join(tmpdir(), "mill-"));
  const dispatcher = createDispatcher({ store: sharedStore, tmux, stateDir: root, baseUrl: () => "http://x", hookCommand: ["hook"] });
  const tasks = createTasks({
    store: sharedStore,
    tmux,
    git: createGit(root, async () => ({ code: 0, stdout: "" })),
    tracker: createLogTracker(),
    notifier: createLogNotifier(),
    pool: ["claude", "codex"],
    sessionsDir: join(root, "sessions"),
    baseUrl: () => "http://x",
    hookCommand: ["hook"],
    checkRepo: async () => {},
  });
  return { dispatcher, tasks, bot: createBot({ api: api(), chatId: "42", store: sharedStore, tasks, dispatcher }) };
}

beforeEach(() => {
  calls = [];
  updates = [];
  tmux = new FakeTmux();
  store = openStore(":memory:");
  nextMessageId = 0;
});

test("messages from another chat are dropped without a reply", async () => {
  const { bot } = setup();
  updates.push(incoming(1, "hello", 99));
  await bot.pollOnce();
  expect(tmux.sent.size).toBe(0);
  expect(sent()).toEqual([]);
});

test("a plain message is typed into the dispatcher", async () => {
  const { bot, dispatcher } = setup();
  await dispatcher.ensure();
  updates.push(incoming(1, "build a thing"));
  await bot.pollOnce();
  expect(tmux.sent.get(dispatcherSession)).toEqual(["[telegram] build a thing"]);
});

test("a reply to a stored question reaches the task session and resumes the task", async () => {
  const { bot } = setup();
  const task = store.insertTask({ kind: "build", title: "T", ticket_id: "KIR-1" });
  store.updateTask(task.id, { state: "running", session: "mill-t1" });
  const notifier = createTelegramNotifier(api(), "42", store);
  const messageId = await notifier.ask(task.id, "KIR-1: which db?");
  store.updateTask(task.id, { state: "waiting_answer" });

  updates.push(incoming(1, "postgres", 42, messageId));
  await bot.pollOnce();

  expect(tmux.sent.get("mill-t1")).toEqual(["Kirill answers: postgres"]);
  expect(store.getTask(task.id)?.state).toBe("running");
  expect(tmux.sent.has(dispatcherSession)).toBe(false);
});

test("/reset restarts the dispatcher and confirms", async () => {
  const { bot, dispatcher } = setup();
  await dispatcher.ensure();
  const before = tmux.sessions.get(dispatcherSession);
  updates.push(incoming(1, "/reset"));
  await bot.pollOnce();
  expect(tmux.sessions.get(dispatcherSession)).not.toBe(before);
  expect(sent()).toEqual(["dispatcher reset"]);
});

test("the poll offset survives a new bot instance", async () => {
  const first = setup();
  updates.push(incoming(7, "hi"));
  await first.bot.pollOnce();
  const second = setup(store);
  await second.bot.pollOnce();
  const offsets = calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset);
  expect(offsets).toEqual([0, 8]);
});

test("a long message is split into 4000 character parts", async () => {
  const notifier = createTelegramNotifier(api(), "42", store);
  await notifier.send("a".repeat(9000));
  expect(sent().map((text) => (text as string).length)).toEqual([4000, 4000, 1000]);
});
