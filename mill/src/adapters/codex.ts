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

export const codex: Adapter = {
  type: "codex",
  launch: (ctx) => ({ argv: ["codex", ...flags(ctx)], env: {} }),
  resume: (ctx) => ({ argv: ["codex", "resume", ctx.conversationId ?? "", ...flags(ctx)], env: {} }),
  conversationId: (payload) => (payload as { "thread-id"?: string })["thread-id"],
};
