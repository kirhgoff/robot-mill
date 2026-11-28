import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters";
import type { LimitHit } from "./limits";
import type { LinearIssue } from "./linear";
import type { Git } from "./worktree";
import type { Notifier } from "./notifier";
import { parsePr } from "./github";
import type { ReviewInput } from "./github-app";
import { promptFor } from "./prompts";
import { nextAssignments, type Slot } from "./scheduler";
import type { AgentType, Store, Task, TaskState } from "./store";
import type { Tmux } from "./tmux";
import type { Tracker } from "./tracker";

export type TasksDeps = {
  store: Store;
  tmux: Tmux;
  git: Git;
  tracker: Tracker;
  notifier: Notifier;
  pool: AgentType[];
  sessionsDir: string;
  baseUrl: () => string;
  hookCommand: string[];
  checkRepo: (repo: string) => Promise<void>;
  postReview: (prUrl: string, review: ReviewInput) => Promise<void>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
};

const slotHolding: TaskState[] = ["running", "waiting_answer", "paused_limit"];

export const restartMessage = "The farm restarted; continue where you left off.";
const resumeDelayMs = 60_000;
const idleNudge = "Call complete_task with the PR link or a failure reason, or ask_question if you are blocked.";

const pinnedType = (labels: string[]): AgentType | null =>
  labels.includes("worker:claude") ? "claude" : labels.includes("worker:codex") ? "codex" : null;

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export function createTasks(deps: TasksDeps) {
  const { store, tmux, git, tracker, notifier } = deps;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  let ticking: Promise<void> = Promise.resolve();

  function ticketPrefix(task: Task) {
    return `${task.ticket_id ?? task.id}: `;
  }

  function parentOf(task: Task) {
    return task.parent ? store.getTask(task.parent) : null;
  }

  function slots(): Slot[] {
    const held: Partial<Record<AgentType, number>> = {};
    for (const task of store.listTasks()) {
      if (slotHolding.includes(task.state) && task.agent_type) held[task.agent_type] = (held[task.agent_type] ?? 0) + 1;
    }
    const limited = new Set(store.listTasks("paused_limit").map((task) => task.agent_type));
    return deps.pool.map((type) => {
      const remaining = held[type] ?? 0;
      held[type] = remaining - 1;
      return { type, busy: remaining > 0 || limited.has(type) };
    });
  }

  async function start(task: Task, type: AgentType) {
    const parent = task.kind === "fix" ? parentOf(task) : null;
    const session = parent?.session ?? `mill-${task.id}`;
    const cwd = join(deps.sessionsDir, task.id);
    mkdirSync(cwd, { recursive: true });
    const conversationId = parent ? parent.conversation_id : type === "claude" ? randomUUID() : null;
    const running = store.updateTask(task.id, {
      state: "running",
      agent_type: type,
      session,
      conversation_id: conversationId,
      ...(parent && { repo: parent.repo, branch: parent.branch, worktree: parent.worktree }),
    });
    const prompt = promptFor(running);
    if (await tmux.has(session)) {
      await sendPrompt(running, prompt);
      return;
    }
    await launch(running, { cwd, prompt, resume: Boolean(parent && conversationId) });
  }

  function sendPrompt(task: Task, text: string) {
    store.updateTask(task.id, { last_prompt_at: now(), nudges: 0 });
    return tmux.send(task.session as string, text);
  }

  async function launch(task: Task, options: { cwd: string; prompt: string; resume: boolean }) {
    const session = task.session as string;
    const base = deps.baseUrl();
    const ctx = {
      session,
      cwd: options.cwd,
      conversationId: task.conversation_id,
      prompt: options.prompt,
      mcpUrl: `${base}/mcp?session=${session}`,
      hookCommand: [...deps.hookCommand, `${base}/hook/turn-end?session=${session}`],
    };
    const adapter = adapters[task.agent_type as AgentType];
    const { argv, env } = options.resume ? adapter.resume(ctx) : adapter.launch(ctx);
    store.updateTask(task.id, { last_prompt_at: now(), nudges: 0 });
    await tmux.start(session, options.cwd, argv, env);
  }

  async function runTick() {
    const assignments = nextAssignments(store.listTasks("queued"), slots(), (task) => parentOf(task)?.agent_type ?? null);
    for (const { task, type } of assignments) {
      try {
        await start(task, type);
      } catch (error) {
        await fail(task, `could not start: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  function tick() {
    ticking = ticking.then(runTick);
    return ticking;
  }

  async function fail(task: Task, reason: string) {
    store.updateTask(task.id, { state: "failed", failure: reason });
    if (task.ticket_id) {
      await tracker.move(task.ticket_id, "Agent Failed");
      await tracker.comment(task.ticket_id, reason);
    }
    await notifier.send(`${ticketPrefix(task)}failed: ${reason}`);
  }

  async function submit(input: { title: string; description: string; linear_project: string; worker?: AgentType }) {
    const ticket = await tracker.create({ title: input.title, description: input.description, project: input.linear_project });
    const task = store.insertTask({
      kind: "build",
      title: input.title,
      description: input.description,
      linear_project: input.linear_project,
      pinned_type: input.worker ?? null,
      ticket_id: ticket.id,
      ticket_url: ticket.url,
    });
    await tick();
    return { id: task.id, ticket_id: ticket.id, url: ticket.url };
  }

  async function queueFix(parentId: string) {
    const parent = store.getTask(parentId);
    if (!parent) throw new Error(`unknown task ${parentId}`);
    const fix = store.insertTask({
      kind: "fix",
      parent: parent.id,
      title: parent.title,
      description: parent.description,
      ticket_id: parent.ticket_id,
      ticket_url: parent.ticket_url,
      pr_url: parent.pr_url,
    });
    store.updateTask(parent.id, { last_activity_at: now() });
    await tick();
    return fix;
  }

  async function prepareWorktree(task: Task, repo: string) {
    if (task.worktree) return task.worktree;
    await deps.checkRepo(repo);
    await git.ensureClone(repo);
    if (task.kind === "review") {
      const pr = parsePr(task.pr_url ?? "").number;
      const path = await git.addPrWorktree(repo, pr);
      store.updateTask(task.id, { repo, branch: `review-${pr}`, worktree: path });
      return path;
    }
    const branch = `${(task.ticket_id ?? task.id).toLowerCase()}-${slugify(task.title)}`;
    const worktree = await git.addWorktree(repo, branch);
    store.updateTask(task.id, { repo, branch, worktree });
    return worktree;
  }

  function recordSignal(task: Task) {
    store.updateTask(task.id, { last_signal_at: now(), nudges: 0 });
  }

  async function complete(task: Task, result: { pr_url?: string; failure?: string }) {
    recordSignal(task);
    if (result.failure) {
      await fail(task, result.failure);
    } else if (task.kind === "build") {
      if (!result.pr_url) throw new Error("pr_url is required to complete a build task");
      queueReview(store.updateTask(task.id, { state: "pr_open", pr_url: result.pr_url, last_activity_at: now() }));
    } else {
      store.updateTask(task.id, { state: "done" });
      if (task.kind === "review") await endReview(task);
      else await afterFix(task);
    }
    await tick();
  }

  function queueReview(build: Task) {
    store.insertTask({
      kind: "review",
      parent: build.id,
      title: build.title,
      description: build.description,
      linear_project: build.linear_project,
      ticket_id: build.ticket_id,
      ticket_url: build.ticket_url,
      pr_url: build.pr_url,
    });
  }

  const roundsKey = (prUrl: string) => `review_rounds:${prUrl}`;
  const findingsKey = (prUrl: string) => `review_findings:${prUrl}`;

  async function afterFix(fix: Task) {
    const build = parentOf(fix);
    if (!build?.pr_url) return;
    const rounds = Number(store.getKv(roundsKey(build.pr_url)) ?? 0);
    if (rounds < 2 && store.getKv(findingsKey(build.pr_url)) === "1") queueReview(build);
    else await notifier.send(`${ticketPrefix(build)}PR ready for you: ${build.pr_url}`);
  }

  async function submitReview(task: Task, review: ReviewInput) {
    const build = parentOf(task);
    if (task.kind !== "review" || !build?.pr_url) throw new Error(`task ${task.id} is not a review task`);
    await deps.postReview(build.pr_url, review);
    const rounds = Number(store.getKv(roundsKey(build.pr_url)) ?? 0) + 1;
    const findings = review.event === "REQUEST_CHANGES" || review.comments.length > 0;
    store.setKv(roundsKey(build.pr_url), String(rounds));
    store.setKv(findingsKey(build.pr_url), findings ? "1" : "0");
    store.updateTask(task.id, { state: "done" });
    await endReview(task);
    if (findings) await queueFix(build.id);
    else await notifier.send(`${ticketPrefix(build)}PR ready for you: ${build.pr_url}`);
    await tick();
  }

  const unfinished: TaskState[] = ["queued", ...slotHolding];

  function findOpenPr(prUrl: string) {
    return store.listTasks("pr_open").find((task) => task.kind === "build" && task.pr_url === prUrl);
  }

  function hasQueuedFix(build: Task) {
    return store.listTasks("queued").some((task) => task.kind === "fix" && task.parent === build.id);
  }

  async function closePr(build: Task, merged: boolean) {
    for (const child of store.listTasks().filter((task) => task.parent === build.id && unfinished.includes(task.state))) {
      store.updateTask(child.id, { state: "canceled" });
      await endReview(child);
    }
    await endReview(build);
    store.updateTask(build.id, { state: merged ? "done" : "canceled" });
    if (build.ticket_id) await tracker.move(build.ticket_id, merged ? "Done" : "Canceled");
    await notifier.send(`${ticketPrefix(build)}${merged ? "merged" : "closed"}: ${build.pr_url}`);
    await tick();
  }

  async function endReview(task: Task) {
    if (task.repo && task.branch) await git.removeWorktree(task.repo, task.branch);
    if (task.session) await tmux.kill(task.session);
  }

  async function stop(task: Task) {
    if (task.session) await tmux.kill(task.session);
    store.updateTask(task.id, { state: "canceled" });
    if (task.ticket_id) {
      await tracker.move(task.ticket_id, "Agent Failed");
      await tracker.comment(task.ticket_id, "stopped by Kirill");
    }
    await tick();
  }

  async function answer(task: Task, text: string) {
    if (!task.session) throw new Error(`task ${task.id} has no session`);
    await sendPrompt(task, text);
    if (task.state === "waiting_answer") store.updateTask(task.id, { state: "running" });
  }

  async function ask(task: Task, text: string) {
    recordSignal(task);
    store.updateTask(task.id, { state: "waiting_answer" });
    return notifier.ask(task.id, `${ticketPrefix(task)}${text}`);
  }

  async function message(text: string, task?: Task) {
    if (task) recordSignal(task);
    return notifier.send(`${task ? ticketPrefix(task) : ""}${text}`);
  }

  function activeFor(session: string) {
    return store.listTasks().findLast((task) => task.session === session && slotHolding.includes(task.state));
  }

  function recordConversation(session: string, payload: unknown) {
    const latest = store.listTasks().findLast((candidate) => candidate.session === session);
    const root = latest?.kind === "fix" ? parentOf(latest) : latest;
    if (!root?.agent_type || root.conversation_id) return;
    const conversationId = adapters[root.agent_type].conversationId(payload);
    if (conversationId) store.updateTask(root.id, { conversation_id: conversationId });
  }

  async function onTurnEnd(session: string, payload: unknown) {
    recordConversation(session, payload);
    const task = activeFor(session);
    if (task?.state !== "running" || !task.agent_type) return;
    const hit = adapters[task.agent_type].detectLimit(await tmux.capture(session), new Date(now()));
    if (!hit && task.limit_line) store.updateTask(task.id, { limit_line: null });
    if (hit && hit.line !== task.limit_line) await pauseForLimit(task, hit);
    else if ((task.last_signal_at ?? 0) < (task.last_prompt_at ?? 0)) await handleSilentTurn(task);
  }

  async function handleSilentTurn(task: Task) {
    if (task.nudges === 0) {
      await tmux.send(task.session as string, idleNudge);
    } else if (task.nudges === 1) {
      await notifier.send(`worker idle on ${task.ticket_id ?? task.id}: tmux attach -t ${task.session}`);
    } else return;
    store.updateTask(task.id, { nudges: task.nudges + 1 });
  }

  async function pauseForLimit(task: Task, hit: LimitHit) {
    const paused = store.updateTask(task.id, { state: "paused_limit", reset_at: hit.resetAt.getTime(), limit_line: hit.line });
    armResume(paused);
    const time = hit.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const note = hit.guessed ? " (reset time not readable, assuming 1 hour)" : "";
    await notifier.send(`${ticketPrefix(task)}${task.agent_type} hit its limit, resets ${time}${note}`);
  }

  function armResume(task: Task) {
    const wait = Math.max(0, (task.reset_at ?? 0) + resumeDelayMs - now());
    schedule(() => resumeAfterLimit(task.id).catch(console.error), wait);
  }

  async function resumeAfterLimit(id: string) {
    const task = store.getTask(id);
    if (task?.state !== "paused_limit") return;
    const resumed = store.updateTask(id, { state: "running", reset_at: null });
    await sendPrompt(resumed, "continue");
    await tick();
  }

  async function revive(task: Task) {
    const root = task.kind === "fix" ? parentOf(task) : task;
    const conversationId = root?.conversation_id ?? task.conversation_id;
    const cwd = join(deps.sessionsDir, task.id);
    mkdirSync(cwd, { recursive: true });
    const withConversation = store.updateTask(task.id, { conversation_id: conversationId });
    const resume = Boolean(conversationId);
    const prompt = !resume ? promptFor(task) : task.state === "paused_limit" ? "" : restartMessage;
    await launch(withConversation, { cwd, prompt, resume });
  }

  async function queueIssue(issue: LinearIssue) {
    if (store.listTasks().some((task) => task.ticket_id === issue.identifier)) return false;
    store.insertTask({
      kind: "build",
      title: issue.title,
      description: issue.description,
      linear_project: issue.project,
      pinned_type: pinnedType(issue.labels),
      ticket_id: issue.identifier,
      ticket_url: issue.url,
    });
    await tick();
    return true;
  }

  return {
    get: store.getTask,
    list: store.listTasks,
    submit,
    tick,
    queueFix,
    prepareWorktree,
    complete,
    stop,
    submitReview,
    findOpenPr,
    hasQueuedFix,
    closePr,
    answer,
    ask,
    message,
    activeFor,
    onTurnEnd,
    revive,
    armResume,
    queueIssue,
  };
}

export type Tasks = ReturnType<typeof createTasks>;
