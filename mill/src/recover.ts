import type { LinearIssue } from "./linear";
import { type Runner, runOrThrow } from "./run";
import type { Task } from "./store";
import type { Tasks } from "./tasks";
import type { Tmux } from "./tmux";

export type PrView = {
  state: string;
  reviews: { author: { login: string }; submittedAt: string }[];
  comments: { author: { login: string }; createdAt: string }[];
};

export type RecoverDeps = {
  tasks: Tasks;
  tmux: Tmux;
  viewPr: (prUrl: string) => Promise<PrView>;
  agentQueue?: () => Promise<LinearIssue[]>;
  botLogins: string[];
};

const inFlight = ["running", "waiting_answer", "paused_limit"];
const loginKey = (login: string) => login.replace(/^app\//, "").replace(/\[bot\]$/, "");

export function createPrViewer(runner: Runner) {
  return async (prUrl: string) =>
    JSON.parse(await runOrThrow(runner, ["gh", "pr", "view", prUrl, "--json", "state,mergedAt,reviews,comments"])) as PrView;
}

export function createRecover({ tasks, tmux, viewPr, agentQueue, botLogins }: RecoverDeps) {
  const bots = new Set(botLogins.map(loginKey));

  function hasNewHumanActivity(build: Task, view: PrView) {
    const since = build.last_activity_at ?? 0;
    const events = [...view.reviews.map((r) => ({ at: r.submittedAt, author: r.author })), ...view.comments.map((c) => ({ at: c.createdAt, author: c.author }))];
    return events.some((event) => Date.parse(event.at) > since && !bots.has(loginKey(event.author.login)));
  }

  async function reconcilePr(build: Task) {
    const view = await viewPr(build.pr_url as string);
    if (view.state === "MERGED" || view.state === "CLOSED") await tasks.closePr(build, view.state === "MERGED");
    else if (hasNewHumanActivity(build, view) && !tasks.hasQueuedFix(build)) await tasks.queueFix(build.id);
  }

  async function each(items: Task[], work: (task: Task) => Promise<unknown>) {
    for (const task of items) await work(task).catch((error) => console.error(`recover ${task.id}:`, error));
  }

  return async function recover() {
    const all = tasks.list();
    const sessions = await Promise.all(all.filter((task) => inFlight.includes(task.state) && task.session).map(async (task) => ({ task, alive: await tmux.has(task.session as string) })));
    await each(sessions.filter((entry) => !entry.alive).map((entry) => entry.task), tasks.revive);
    for (const task of all.filter((task) => task.state === "paused_limit")) tasks.armResume(task);
    await each(all.filter((task) => task.state === "pr_open" && task.pr_url), reconcilePr);
    for (const issue of (await agentQueue?.()) ?? []) await tasks.queueIssue(issue).catch(console.error);
    await tasks.tick();
  };
}
