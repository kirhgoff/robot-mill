import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env";
import { startServer } from "./http";
import { createDispatcher } from "./dispatcher";
import { createLogNotifier } from "./notifier";
import { run } from "./run";
import type { AgentType } from "./store";
import { openStore } from "./store";
import { createTasks } from "./tasks";
import { createBot, createTelegramApi, createTelegramNotifier } from "./telegram";
import { createTmux } from "./tmux";
import { createLinearTracker } from "./linear";
import { createLinearWebhook } from "./linear-webhook";
import { createGithubWebhook } from "./github-webhook";
import { createReviewPoster } from "./github-app";
import { createGh, owner } from "./github";
import { createCheckRepo, linearRepos, protectRepo } from "./protect";
import { createLogTracker } from "./tracker";
import { createPrViewer, createRecover } from "./recover";
import { createGit } from "./worktree";

const [, , command, hookUrl, payloadArg] = process.argv;
if (command === "serve") loadEnv(process.env.MILL_ENV_FILE ?? join(homedir(), ".config", "mill", "mill.env"));

const botLogin = process.env.MILL_BOT_LOGIN ?? "millwright";

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
  const linear = process.env.LINEAR_API_KEY ? createLinearTracker({ apiKey: process.env.LINEAR_API_KEY, team: process.env.LINEAR_TEAM }) : null;
  const postReview =
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_PATH
      ? createReviewPoster({ appId: process.env.GITHUB_APP_ID, keyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH })
      : async () => {
          throw new Error("submit_review needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH");
        };
  const tasks = createTasks({
    store,
    tmux,
    git: createGit(projects, run),
    tracker: linear ?? createLogTracker(),
    notifier: telegram ? createTelegramNotifier(telegram.api, telegram.chatId, store) : createLogNotifier(),
    pool,
    sessionsDir: join(stateDir, "sessions"),
    baseUrl: () => `http://127.0.0.1:${port}`,
    hookCommand: [process.execPath, import.meta.path, "hook"],
    checkRepo: createCheckRepo(createGh(run)),
    postReview,
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const dispatcher = createDispatcher({ store, tmux, stateDir, baseUrl, hookCommand: [process.execPath, import.meta.path, "hook"] });
  const linearWebhook = process.env.LINEAR_WEBHOOK_SECRET && linear ? createLinearWebhook({ secret: process.env.LINEAR_WEBHOOK_SECRET, tasks, linear }) : undefined;
  const githubWebhook = process.env.GITHUB_WEBHOOK_SECRET
    ? createGithubWebhook({ secret: process.env.GITHUB_WEBHOOK_SECRET, tasks, botLogin, appLogin: process.env.MILL_APP_LOGIN ?? "mill-inspector[bot]" })
    : undefined;
  startServer(port, tasks, (payload) => dispatcher.onTurnEnd(payload), linearWebhook, githubWebhook);
  dispatcher.ensure().catch(console.error);
  createRecover({
    tasks,
    tmux,
    viewPr: createPrViewer(run),
    agentQueue: linear ? () => linear.agentQueueIssues() : undefined,
    botLogins: [botLogin, process.env.MILL_APP_LOGIN ?? "mill-inspector[bot]"],
  })().catch(console.error);
  setInterval(() => dispatcher.tick().catch(console.error), 60_000);
  if (telegram) void createBot({ ...telegram, store, tasks, dispatcher }).run();
  console.log(`mill listening on 127.0.0.1:${port}`);
}

async function protect(args: string[]) {
  const gh = createGh(run);
  let repos = args.filter((arg) => arg !== "--all-linear");
  if (args.includes("--all-linear")) {
    if (!process.env.LINEAR_API_KEY) throw new Error("--all-linear needs LINEAR_API_KEY");
    const { mapped, unmapped } = await linearRepos(gh, await createLinearTracker({ apiKey: process.env.LINEAR_API_KEY, team: process.env.LINEAR_TEAM }).projects());
    repos = [...repos, ...mapped];
    if (unmapped.length) console.log(`No ${owner}/<name> repo for: ${unmapped.join(", ")}. Run mill protect <repo> for each by hand.`);
  }
  for (const repo of repos) {
    await protectRepo(gh, repo, botLogin);
    console.log(`protected ${owner}/${repo}`);
  }
}

if (command === "hook" && hookUrl) await forwardHook(hookUrl, payloadArg);
else if (command === "protect") await protect(process.argv.slice(3));
else serve();
