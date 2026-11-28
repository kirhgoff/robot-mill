import type { AgentType } from "../store";
import { claude } from "./claude";
import { codex } from "./codex";

export type LaunchContext = {
  session: string;
  mcpUrl: string;
  hookCommand: string[];
  cwd: string;
  conversationId: string | null;
};

export type Launch = { argv: string[]; env: Record<string, string> };

export type Adapter = {
  type: AgentType;
  launch(ctx: LaunchContext): Launch;
  resume(ctx: LaunchContext): Launch;
  conversationId(turnEndPayload: unknown): string | undefined;
};

export const adapters: Record<AgentType, Adapter> = { claude, codex };
