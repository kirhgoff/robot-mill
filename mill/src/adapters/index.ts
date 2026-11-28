import type { LimitHit } from "../limits";
import type { AgentType } from "../store";
import { claude } from "./claude";
import { codex } from "./codex";

export type LaunchContext = {
  session: string;
  mcpUrl: string;
  hookCommand: string[];
  cwd: string;
  conversationId: string | null;
  prompt: string;
};

type Launch = { argv: string[]; env: Record<string, string> };

export type Adapter = {
  type: AgentType;
  launch(ctx: LaunchContext): Launch;
  resume(ctx: LaunchContext): Launch;
  conversationId(turnEndPayload: unknown): string | undefined;
  detectLimit(paneText: string, now: Date): LimitHit | null;
};

export const adapters: Record<AgentType, Adapter> = { claude, codex };
