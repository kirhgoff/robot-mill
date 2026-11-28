import type { Task } from "./store";

const contract = `Tools on the "mill" MCP server: prepare_worktree(repo), ask_question(task, text), send_message(text, task), complete_task(task, pr_url | failure).`;

function ticketLine(task: Task) {
  return `Ticket ${task.ticket_id} (${task.ticket_url}): ${task.title}`;
}

function buildPrompt(task: Task) {
  return [
    `You are the worker for task ${task.id}.`,
    ticketLine(task),
    task.description,
    contract,
    `Move the ticket to In Progress. Find the repo from the ticket's Linear project and call prepare_worktree(repo) first; work only in the worktree it returns.`,
    `Build the change, open a PR, link ticket and PR both ways, move the ticket to In Review, then call complete_task(task="${task.id}", pr_url).`,
    `If you cannot finish, call complete_task(task="${task.id}", failure) with the reason. If you need an answer from Kirill, call ask_question.`,
  ].join("\n");
}

function reviewPrompt(task: Task) {
  return [
    `You are the reviewer for task ${task.id}.`,
    ticketLine(task),
    `Review the pull request ${task.pr_url}. Call prepare_worktree(repo) for a fresh review worktree and read the diff there.`,
    contract,
    `Report findings by calling send_message, then call complete_task(task="${task.id}").`,
  ].join("\n");
}

function fixPrompt(task: Task) {
  return [
    `Fix round for task ${task.parent}.`,
    ticketLine(task),
    `Address the review findings on ${task.pr_url}: fix each in its own commit, push, and reply in each thread with "RESOLVED in <sha> - <how>", or the reason it was left unchanged.`,
    `Then call complete_task(task="${task.id}").`,
  ].join("\n");
}

export function promptFor(task: Task) {
  if (task.kind === "review") return reviewPrompt(task);
  if (task.kind === "fix") return fixPrompt(task);
  return buildPrompt(task);
}

export const dispatcherPrompt = [
  `You are the dispatcher of the robot mill. Kirill's Telegram messages reach you as lines starting with "[telegram]".`,
  `Turn each request into a task by calling submit_task(title, description, linear_project, worker?). Resolve the Linear project with the Linear skill. Pass worker "claude" or "codex" only when Kirill says "use Claude" or "use Codex".`,
  `Answer status questions with list_tasks and task_status. Reply to Kirill only through send_message.`,
  `Call ask_question only when a request is too unclear to file; otherwise act without asking.`,
].join("\n");
