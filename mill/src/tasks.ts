import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters";
import type { Git } from "./worktree";
import type { Notifier } from "./notifier";
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
};

const slotHolding: TaskState[] = ["running", "waiting_answer", "paused_limit"];

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export function createTasks(deps: TasksDeps) {
  const { store, tmux, git, tracker, notifier } = deps;
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
    return deps.pool.map((type) => {
      const remaining = held[type] ?? 0;
      held[type] = remaining - 1;
      return { type, busy: remaining > 0 };
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
      await tmux.send(session, prompt);
      return;
    }
    const base = deps.baseUrl();
    const ctx = {
      session,
      cwd,
      conversationId,
      prompt,
      mcpUrl: `${base}/mcp?session=${session}`,
      hookCommand: [...deps.hookCommand, `${base}/hook/turn-end?session=${session}`],
    };
    const adapter = adapters[type];
    const launch = parent && conversationId ? adapter.resume(ctx) : adapter.launch(ctx);
    await tmux.start(session, cwd, launch.argv, launch.env);
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
    await tick();
    return fix;
  }

  async function prepareWorktree(task: Task, repo: string) {
    if (task.worktree) return task.worktree;
    await deps.checkRepo(repo);
    await git.ensureClone(repo);
    const branch = task.kind === "review" ? `review-${task.id}` : `${(task.ticket_id ?? task.id).toLowerCase()}-${slugify(task.title)}`;
    const worktree = await git.addWorktree(repo, branch);
    store.updateTask(task.id, { repo, branch, worktree });
    return worktree;
  }

  async function complete(task: Task, result: { pr_url?: string; failure?: string }) {
    if (result.failure) {
      await fail(task, result.failure);
    } else if (task.kind === "build") {
      if (!result.pr_url) throw new Error("pr_url is required to complete a build task");
      store.updateTask(task.id, { state: "pr_open", pr_url: result.pr_url });
      store.insertTask({
        kind: "review",
        parent: task.id,
        title: task.title,
        description: task.description,
        linear_project: task.linear_project,
        ticket_id: task.ticket_id,
        ticket_url: task.ticket_url,
        pr_url: result.pr_url,
      });
    } else {
      store.updateTask(task.id, { state: "done" });
      if (task.kind === "review") await endReview(task);
    }
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
    await tmux.send(task.session, text);
    if (task.state === "waiting_answer") store.updateTask(task.id, { state: "running" });
  }

  async function ask(task: Task, text: string) {
    store.updateTask(task.id, { state: "waiting_answer" });
    return notifier.ask(task.id, `${ticketPrefix(task)}${text}`);
  }

  async function message(text: string, task?: Task) {
    return notifier.send(`${task ? ticketPrefix(task) : ""}${text}`);
  }

  function activeFor(session: string) {
    return store.listTasks().findLast((task) => task.session === session && slotHolding.includes(task.state));
  }

  function onTurnEnd(session: string, payload: unknown) {
    const latest = store.listTasks().findLast((candidate) => candidate.session === session);
    const root = latest?.kind === "fix" ? parentOf(latest) : latest;
    if (!root?.agent_type || root.conversation_id) return;
    const conversationId = adapters[root.agent_type].conversationId(payload);
    if (conversationId) store.updateTask(root.id, { conversation_id: conversationId });
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
    answer,
    ask,
    message,
    activeFor,
    onTurnEnd,
  };
}

export type Tasks = ReturnType<typeof createTasks>;
