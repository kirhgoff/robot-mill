import type { Task } from "./store";

const contract = `Tools on the "mill" MCP server: prepare_worktree(repo), ask_question(task, text), send_message(text, task), complete_task(task, pr_url | failure).`;

function ticketLine(task: Task) {
  return `Ticket ${task.ticket_id} (${task.ticket_url}): ${task.title}`;
}

export function buildPrompt(task: Task) {
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

export function reviewPrompt(task: Task) {
  return [
    `You are the reviewer for task ${task.id}.`,
    ticketLine(task),
    `Review the pull request ${task.pr_url}. Call prepare_worktree(repo) for a fresh review worktree and read the diff there.`,
    contract,
    `Report findings by calling send_message, then call complete_task(task="${task.id}").`,
  ].join("\n");
}

export function fixPrompt(task: Task) {
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
