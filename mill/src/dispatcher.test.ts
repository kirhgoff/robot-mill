import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, dispatcherSession, readContextUsage } from "./dispatcher";
import { openStore } from "./store";
import { FakeTmux } from "./tmux.fake";

let tmux: FakeTmux;
let clock: Date;
let usage: number | null;

function build() {
  return createDispatcher({
    store: openStore(":memory:"),
    tmux,
    stateDir: mkdtempSync(join(tmpdir(), "mill-")),
    baseUrl: () => "http://127.0.0.1:1",
    hookCommand: ["hook"],
    now: () => clock,
    contextUsage: () => usage,
  });
}

const at = (hour: number, day = 1) => new Date(2026, 0, day, hour, 0, 0);
const turnEnd = { "thread-id": "abc" };

beforeEach(() => {
  tmux = new FakeTmux();
  clock = at(3);
  usage = 0.1;
});

test("ensure starts the dispatcher with the role prompt as the last argument, once", async () => {
  const dispatcher = build();
  await dispatcher.ensure();
  const started = tmux.sessions.get(dispatcherSession);
  expect(started?.argv[0]).toBe("codex");
  expect(started?.argv.at(-1)).toContain("dispatcher");
  const before = started;
  await dispatcher.ensure();
  expect(tmux.sessions.get(dispatcherSession)).toBe(before);
});

test("daily reset fires once per day, only when idle and after 04:00", async () => {
  const dispatcher = build();
  await dispatcher.ensure();
  await dispatcher.onTurnEnd({});
  const first = tmux.sessions.get(dispatcherSession);

  await dispatcher.checkDaily();
  expect(tmux.sessions.get(dispatcherSession)).toBe(first);

  clock = at(4);
  await dispatcher.send("[telegram] busy");
  await dispatcher.checkDaily();
  expect(tmux.sessions.get(dispatcherSession)).toBe(first);

  clock = at(5);
  await dispatcher.onTurnEnd({});
  await dispatcher.checkDaily();
  const second = tmux.sessions.get(dispatcherSession);
  expect(second).not.toBe(first);

  clock = at(6);
  await dispatcher.onTurnEnd({});
  await dispatcher.checkDaily();
  expect(tmux.sessions.get(dispatcherSession)).toBe(second);

  clock = at(5, 2);
  await dispatcher.onTurnEnd({});
  await dispatcher.checkDaily();
  expect(tmux.sessions.get(dispatcherSession)).not.toBe(second);
});

test("a turn above 60% of the context window resets the dispatcher, below does not", async () => {
  const dispatcher = build();
  await dispatcher.ensure();
  const first = tmux.sessions.get(dispatcherSession);
  usage = 0.59;
  await dispatcher.onTurnEnd(turnEnd);
  expect(tmux.sessions.get(dispatcherSession)).toBe(first);
  usage = 0.61;
  await dispatcher.onTurnEnd(turnEnd);
  expect(tmux.sessions.get(dispatcherSession)).not.toBe(first);
});

function rollout(lines: string[]) {
  const root = mkdtempSync(join(tmpdir(), "codex-"));
  mkdirSync(join(root, "2026", "01"), { recursive: true });
  writeFileSync(join(root, "2026", "01", "rollout-2026-01-01T00-00-00-abc.jsonl"), lines.join("\n"));
  return root;
}

const tokenCount = (used: number, window: number) =>
  JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { total_tokens: used }, model_context_window: window } } });

test("readContextUsage divides the last token count by the context window", () => {
  const root = rollout([tokenCount(10, 100), JSON.stringify({ payload: { type: "message" } }), tokenCount(75, 100)]);
  expect(readContextUsage("abc", root)).toBe(0.75);
});

test("readContextUsage returns null on a malformed, missing or unknown rollout", () => {
  expect(readContextUsage("abc", rollout(["not json", JSON.stringify({ payload: { type: "token_count", info: {} } })]))).toBeNull();
  expect(readContextUsage("abc", rollout(["{}"]))).toBeNull();
  expect(readContextUsage("zzz", rollout([tokenCount(1, 2)]))).toBeNull();
});
