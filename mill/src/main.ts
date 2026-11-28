import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./http";
import { createLogNotifier } from "./notifier";
import { run } from "./run";
import type { AgentType } from "./store";
import { openStore } from "./store";
import { createTasks } from "./tasks";
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
  const tasks = createTasks({
    store: openStore(join(stateDir, "mill.db")),
    tmux: createTmux(run),
    git: createGit(projects, run),
    tracker: createLogTracker(),
    notifier: createLogNotifier(),
    pool,
    sessionsDir: join(stateDir, "sessions"),
    baseUrl: () => `http://127.0.0.1:${port}`,
    hookCommand: [process.execPath, import.meta.path, "hook"],
    checkRepo: async () => {},
  });
  startServer(port, tasks);
  console.log(`mill listening on 127.0.0.1:${port}`);
}

const [, , command, hookUrl, payloadArg] = process.argv;
if (command === "hook" && hookUrl) await forwardHook(hookUrl, payloadArg);
else serve();
