import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claude } from "./claude";
import { codex } from "./codex";

const ctx = {
  session: "mill-t1",
  cwd: "/tmp/t1",
  mcpUrl: "http://127.0.0.1:7600/mcp?session=mill-t1",
  hookCommand: ["bun", "main.ts", "hook", "http://127.0.0.1:7600/hook/turn-end?session=mill-t1"],
  conversationId: "abc-123",
  prompt: "do the thing",
};

test("claude launches with a fixed session id, mcp config and a Stop hook", () => {
  const { argv } = claude.launch(ctx);
  expect(argv.slice(0, 4)).toEqual(["claude", "--session-id", "abc-123", "--dangerously-skip-permissions"]);
  expect(JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string)).toEqual({ mcpServers: { mill: { type: "http", url: ctx.mcpUrl } } });
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] as string);
  expect(settings.hooks.Stop[0].hooks[0].command).toBe(`'bun' 'main.ts' 'hook' '${ctx.hookCommand[3]}'`);
});

test("claude resumes by conversation id with the same flags", () => {
  const launch = claude.launch(ctx).argv;
  const resume = claude.resume(ctx).argv;
  expect(resume.slice(0, 3)).toEqual(["claude", "--resume", "abc-123"]);
  expect(resume.slice(3)).toEqual(launch.slice(3));
  expect(launch.at(-1)).toBe("do the thing");
  expect(resume.at(-1)).toBe("do the thing");
});

test("codex launches with the mcp url and a notify command", () => {
  expect(codex.launch(ctx).argv).toEqual([
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.mill.url="${ctx.mcpUrl}"`,
    "-c",
    `notify=${JSON.stringify(ctx.hookCommand)}`,
    "do the thing",
  ]);
});

test("codex resumes by thread id and reads it from the notify payload", () => {
  const { argv } = codex.resume(ctx);
  expect(argv.slice(0, 3)).toEqual(["codex", "resume", "abc-123"]);
  expect(argv.at(-1)).toBe("do the thing");
  expect(codex.conversationId({ "thread-id": "th-9" })).toBe("th-9");
});

const now = new Date("2026-11-28T10:00:00Z");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const localToday = (hour: number, minute: number) => {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
};

const limitCases: [string, typeof claude, string, Date | null][] = [
  ["claude-time.txt", claude, "3pm local", localToday(15, 0)],
  ["claude-time-zone.txt", claude, "3pm New York", new Date("2026-11-28T20:00:00Z")],
  ["claude-date-zone.txt", claude, "Dec 1 3pm Berlin", new Date("2026-12-01T14:00:00Z")],
  ["claude-unparsable.txt", claude, "unreadable reset", null],
  ["codex-time.txt", codex, "3:05 PM local", localToday(15, 5)],
  ["codex-date.txt", codex, "Dec 1st 2026 3:05 PM local", new Date(2026, 11, 1, 15, 5)],
  ["codex-unparsable.txt", codex, "unreadable reset", null],
];

for (const [file, adapter, label, expected] of limitCases) {
  test(`${adapter.type} limit fixture ${file} (${label})`, () => {
    const hit = adapter.detectLimit(`some output\n${fixture(file)}more output`, now);
    if (expected) expect(hit).toEqual({ resetAt: expected, guessed: false });
    else expect(hit).toEqual({ resetAt: new Date(now.getTime() + 3_600_000), guessed: true });
  });
}

test("ordinary pane text is not a limit", () => {
  expect(claude.detectLimit("Working on the limit of the range", now)).toBeNull();
  expect(codex.detectLimit("all good", now)).toBeNull();
});

test("resume without a prompt leaves the prompt argument out", () => {
  expect(claude.resume({ ...ctx, prompt: "" }).argv.at(-1)).not.toBe("");
  expect(codex.resume({ ...ctx, prompt: "" }).argv.at(-1)).not.toBe("");
});
