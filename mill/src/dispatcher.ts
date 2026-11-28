import { Glob } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapters } from "./adapters";
import { dispatcherPrompt } from "./prompts";
import type { Store } from "./store";
import type { Tmux } from "./tmux";

export const dispatcherSession = "mill-dispatcher";

const contextLimit = 0.6;
const dailyResetHour = 4;
const lastResetKey = "dispatcher_reset_date";

export function readContextUsage(threadId: string, sessionsRoot = join(homedir(), ".codex", "sessions")): number | null {
  const [file] = [...new Glob(`**/rollout-*${threadId}*.jsonl`).scanSync(sessionsRoot)];
  if (!file) return null;
  const lines = readFileSync(join(sessionsRoot, file), "utf8").split("\n").reverse();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line).payload;
      if (payload?.type !== "token_count") continue;
      const used = payload.info?.last_token_usage?.total_tokens;
      const window = payload.info?.model_context_window;
      return typeof used === "number" && typeof window === "number" && window > 0 ? used / window : null;
    } catch {
      continue;
    }
  }
  return null;
}

export type DispatcherDeps = {
  store: Store;
  tmux: Tmux;
  stateDir: string;
  baseUrl: () => string;
  hookCommand: string[];
  now?: () => Date;
  contextUsage?: (threadId: string) => number | null;
};

const localDate = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

export function createDispatcher(deps: DispatcherDeps) {
  const { store, tmux } = deps;
  const now = deps.now ?? (() => new Date());
  const contextUsage = deps.contextUsage ?? readContextUsage;
  let lastSent = 0;
  let lastTurnEnd = 0;
  let warnedUnreadable = false;

  const idle = () => lastTurnEnd >= lastSent;

  async function start() {
    const cwd = join(deps.stateDir, "dispatcher");
    mkdirSync(cwd, { recursive: true });
    const base = deps.baseUrl();
    const launch = adapters.codex.launch({
      session: dispatcherSession,
      cwd,
      conversationId: null,
      prompt: dispatcherPrompt,
      mcpUrl: `${base}/mcp?session=${dispatcherSession}`,
      hookCommand: [...deps.hookCommand, `${base}/hook/turn-end?session=${dispatcherSession}`],
    });
    await tmux.start(dispatcherSession, cwd, launch.argv, launch.env);
    lastSent = now().getTime();
  }

  async function ensure() {
    if (!(await tmux.has(dispatcherSession))) await start();
  }

  async function reset() {
    await tmux.kill(dispatcherSession);
    await start();
  }

  async function send(text: string) {
    lastSent = now().getTime();
    await tmux.send(dispatcherSession, text);
  }

  async function onTurnEnd(payload: unknown) {
    lastTurnEnd = now().getTime();
    const threadId = adapters.codex.conversationId(payload);
    if (!threadId) return;
    const usage = contextUsage(threadId);
    if (usage === null && !warnedUnreadable) {
      warnedUnreadable = true;
      console.warn(`dispatcher: cannot read token count for thread ${threadId}`);
    }
    if (usage !== null && usage > contextLimit) await reset();
  }

  async function checkDaily() {
    const current = now();
    const today = localDate(current);
    if (current.getHours() < dailyResetHour || store.getKv(lastResetKey) === today || !idle()) return;
    await reset();
    store.setKv(lastResetKey, today);
  }

  return { ensure, reset, send, onTurnEnd, checkDaily };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
