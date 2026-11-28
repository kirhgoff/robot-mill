import { limitDetector } from "../limits";
import type { Adapter, LaunchContext } from "./index";

function flags(ctx: LaunchContext) {
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.mill.url=${JSON.stringify(ctx.mcpUrl)}`,
    "-c",
    `notify=${JSON.stringify(ctx.hookCommand)}`,
  ];
}

const promptArgs = (ctx: LaunchContext) => (ctx.prompt ? [ctx.prompt] : []);

export const codex: Adapter = {
  type: "codex",
  launch: (ctx) => ({ argv: ["codex", ...flags(ctx), ...promptArgs(ctx)], env: {} }),
  resume: (ctx) => ({ argv: ["codex", "resume", ctx.conversationId ?? "", ...flags(ctx), ...promptArgs(ctx)], env: {} }),
  conversationId: (payload) => (payload as { "thread-id"?: string })["thread-id"],
  detectLimit: limitDetector(/usage limit[^\n]*/i),
};
