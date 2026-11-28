import { expect, test } from "bun:test";
import { claude } from "./claude";
import { codex } from "./codex";

const ctx = {
  session: "mill-t1",
  cwd: "/tmp/t1",
  mcpUrl: "http://127.0.0.1:7600/mcp?session=mill-t1",
  hookCommand: ["bun", "main.ts", "hook", "http://127.0.0.1:7600/hook/turn-end?session=mill-t1"],
  conversationId: "abc-123",
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
});

test("codex launches with the mcp url and a notify command", () => {
  expect(codex.launch(ctx).argv).toEqual([
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.mill.url="${ctx.mcpUrl}"`,
    "-c",
    `notify=${JSON.stringify(ctx.hookCommand)}`,
  ]);
});

test("codex resumes by thread id and reads it from the notify payload", () => {
  expect(codex.resume(ctx).argv.slice(0, 3)).toEqual(["codex", "resume", "abc-123"]);
  expect(codex.conversationId({ "thread-id": "th-9" })).toBe("th-9");
});
