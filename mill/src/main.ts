import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./http";
import { createDispatcher } from "./dispatcher";
import { createLogNotifier } from "./notifier";
import { run } from "./run";
import type { AgentType } from "./store";
import { openStore } from "./store";
import { createTasks } from "./tasks";
import { createBot, createTelegramApi, createTelegramNotifier } from "./telegram";
import { createTmux } from "./tmux";
import { createLogTracker } from "./tracker";
import { createGit } from "./worktree";

async function forwardHook(url: string, payloadArg: string | undefined) {
  const body = payloadArg ?? (await Bun.stdin.text());
  await fetch(url, { method: "POST", body });
}

function serve() {
  const port = Number(process.env.MILL_PORT ?? 7600);
  const stateDir = process.env.MILL_STATE_DIR ?? join(homedir(), ".local", "state", "mill");
  const projects = process.env.MILL_PROJECTS_DIR ?? join(homedir(), "Projects");
  const pool = (process.env.MILL_POOL ?? "claude,codex").split(",") as AgentType[];
  mkdirSync(stateDir, { recursive: true });
  const store = openStore(join(stateDir, "mill.db"));
  const tmux = createTmux(run);
  const telegram =
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? { api: createTelegramApi({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }), chatId: process.env.TELEGRAM_CHAT_ID }
      : null;
  const tasks = createTasks({
    store,
    tmux,
    git: createGit(projects, run),
    tracker: createLogTracker(),
    notifier: telegram ? createTelegramNotifier(telegram.api, telegram.chatId, store) : createLogNotifier(),
    pool,
    sessionsDir: join(stateDir, "sessions"),
    baseUrl: () => `http://127.0.0.1:${port}`,
    hookCommand: [process.execPath, import.meta.path, "hook"],
    checkRepo: async () => {},
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const dispatcher = createDispatcher({ store, tmux, stateDir, baseUrl, hookCommand: [process.execPath, import.meta.path, "hook"] });
  startServer(port, tasks, (payload) => void dispatcher.onTurnEnd(payload).catch(console.error));
  dispatcher.ensure().catch(console.error);
  setInterval(() => dispatcher.checkDaily().catch(console.error), 60_000);
  if (telegram) void createBot({ ...telegram, store, tasks, dispatcher }).run();
  console.log(`mill listening on 127.0.0.1:${port}`);
}

const [, , command, hookUrl, payloadArg] = process.argv;
if (command === "hook" && hookUrl) await forwardHook(hookUrl, payloadArg);
else serve();
