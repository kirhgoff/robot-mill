import { limitDetector } from "../limits";
import type { Adapter, LaunchContext } from "./index";

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

function flags(ctx: LaunchContext) {
  const mcpConfig = { mcpServers: { mill: { type: "http", url: ctx.mcpUrl } } };
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: ctx.hookCommand.map(shellQuote).join(" ") }] }] } };
  return ["--dangerously-skip-permissions", "--mcp-config", JSON.stringify(mcpConfig), "--settings", JSON.stringify(settings)];
}

const promptArgs = (ctx: LaunchContext) => (ctx.prompt ? ["--", ctx.prompt] : []);

export const claude: Adapter = {
  type: "claude",
  launch: (ctx) => ({ argv: ["claude", "--session-id", ctx.conversationId ?? "", ...flags(ctx), ...promptArgs(ctx)], env: {} }),
  resume: (ctx) => ({ argv: ["claude", "--resume", ctx.conversationId ?? "", ...flags(ctx), ...promptArgs(ctx)], env: {} }),
  conversationId: (payload) => (payload as { session_id?: string }).session_id,
  detectLimit: limitDetector(/hit your limit[^\n]*/i),
};
