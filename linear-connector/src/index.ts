import { loadConfig, validateConfig } from "./config";
import { findPr } from "./github";
import { LinearClient, type LinearIssue, type TeamInfo } from "./linear";
import { notify } from "./telegram";

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length > 0) {
	console.error("Invalid config:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

const linear = new LinearClient(config.linearApiKey);

interface States {
	trigger: string;
	inProgress: string;
	review: string;
	done: string;
	failed: string;
}

interface ActiveTask {
	issue: LinearIssue;
	project: string;
	mode: "code" | "ops";
	key: string;
	name: string;
	startedAt: number;
}

interface TaskStatus {
	key: string;
	running: boolean;
	dir: string;
	repo: string;
	busy: boolean | null;
	startedAt: number | null;
	endedAt: number | null;
	lastText: string | null;
}

type Outcome =
	| { success: true; lastText: string; repo: string }
	| { success: false; reason: string; lastText?: string };

let allowedProjects: string[] = [];
let team: TeamInfo;
let states: States;
const active = new Map<string, ActiveTask>();
let lastPoll = 0;
let ticking = false;
let polling: Promise<void> | null = null;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function waitForHostRunner(): Promise<string[]> {
	for (;;) {
		try {
			const res = await fetch(`${config.hostRunnerUrl}/projects`, { signal: AbortSignal.timeout(5000) });
			if (res.ok) {
				const body = (await res.json()) as { allowed: string[] };
				return body.allowed;
			}
		} catch {}
		console.log(`waiting for host-runner at ${config.hostRunnerUrl}...`);
		await new Promise((resolve) => setTimeout(resolve, 10000));
	}
}

function resolveTarget(issue: LinearIssue): string | undefined {
	if (issue.project && allowedProjects.includes(issue.project)) return issue.project;
	return issue.labels.find((l) => allowedProjects.includes(l));
}

async function getTaskStatus(project: string, name: string): Promise<TaskStatus> {
	const res = await fetch(
		`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/task?name=${encodeURIComponent(name)}`,
		{ signal: AbortSignal.timeout(15000) },
	);
	if (!res.ok) throw new Error(`host-runner GET /task HTTP ${res.status}`);
	return (await res.json()) as TaskStatus;
}

async function deleteTask(project: string, name: string): Promise<void> {
	const res = await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/task`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
		signal: AbortSignal.timeout(30000),
	});
	if (!res.ok) throw new Error(`host-runner DELETE /task HTTP ${res.status}`);
}

async function abortTask(project: string, name: string): Promise<void> {
	await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/abort`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
		signal: AbortSignal.timeout(15000),
	}).catch(() => {});
}

function promptFor(issue: LinearIssue, mode: "code" | "ops", project: string, name: string): string {
	const header = `Linear issue ${issue.identifier}: ${issue.title}`;
	const body = issue.description || "(no description)";
	const instructions =
		mode === "code"
			? `You are in a git worktree at ~/robot-mill/worktrees/${project}/${name} on branch \`${name}\` created from origin's default branch. Install dependencies first (bun install / npm ci per lockfile). Implement, commit, \`git push -u origin ${name}\`, then open a PR against the default branch via the GitHub REST API with $GITHUB_TOKEN (\`gh\` is not installed). Finish with a short summary.`
			: `You are in the project's main checkout at ~/Projects/${project} on the host with full access. Follow the project's AGENTS.md runbook. Do not create branches or pull requests. Finish with a short report of what you ran and the outcome.`;
	return [header, "", body, "", instructions].join("\n");
}

async function dispatch(issue: LinearIssue): Promise<void> {
	const target = resolveTarget(issue);
	if (!target) {
		try {
			await linear.comment(
				issue.id,
				`🤖 No target repo. Put me in a Linear project (or label me) matching one of: ${allowedProjects.join(", ")}, then move me back to ${config.triggerState}.`,
			);
			await linear.moveIssue(issue.id, states.failed);
		} catch (err) {
			console.error(`[${issue.identifier}] failed to record missing target:`, err instanceof Error ? err.message : err);
		}
		return;
	}

	const mode: "code" | "ops" = issue.labels.includes(config.opsLabel) ? "ops" : "code";
	const name = issue.identifier.toLowerCase();
	const key = `${target}-${name}`;

	try {
		const agentLabelId = await linear.ensureLabel(team.id, config.agentLabel);
		await linear.addLabel(issue.id, agentLabelId);
		await linear.comment(issue.id, `🤖 started in \`${target}\` (${mode}) · tmux attach -t pi-${key}`);
		await linear.moveIssue(issue.id, states.inProgress);
	} catch (err) {
		console.error(`[${issue.identifier}] failed to move to in-progress:`, err instanceof Error ? err.message : err);
		return;
	}

	try {
		const res = await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(target)}/task`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, message: promptFor(issue, mode, target, name), worktree: mode === "code" }),
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) throw new Error(`host-runner POST /task HTTP ${res.status}`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "host-runner task dispatch failed";
		await finalize({ issue, project: target, mode, key, name, startedAt: Date.now() }, { success: false, reason });
		return;
	}

	active.set(issue.identifier, { issue, project: target, mode, key, name, startedAt: Date.now() });
	await notify(
		config.telegramBotToken,
		config.telegramChatId,
		`🤖 ${issue.identifier} started · ${target} (${mode}) · tmux attach -t pi-${key}`,
	);
}

async function finalize(task: ActiveTask, outcome: Outcome): Promise<void> {
	let message: string;
	try {
		if (outcome.success) {
			if (task.mode === "code") {
				const prUrl = await findPr(outcome.repo, task.name, config.githubToken).catch(() => null);
				await linear.comment(
					task.issue.id,
					prUrl ? `${outcome.lastText}\n\n${prUrl}` : `${outcome.lastText}\n\n⚠ no PR found for branch ${task.name}`,
				);
				await linear.moveIssue(task.issue.id, states.review);
				message = `✅ ${task.issue.identifier} → In Review${prUrl ? ` ${prUrl}` : ""}`;
			} else {
				await linear.comment(task.issue.id, outcome.lastText);
				await linear.moveIssue(task.issue.id, states.done);
				message = `✅ ${task.issue.identifier} ops done`;
			}
		} else {
			await linear.comment(
				task.issue.id,
				outcome.lastText ? `❌ ${outcome.reason}\n\n${outcome.lastText}` : `❌ ${outcome.reason}`,
			);
			await linear.moveIssue(task.issue.id, states.failed);
			message = `❌ ${task.issue.identifier} failed: ${outcome.reason} ${task.issue.url}`;
		}
	} catch (err) {
		console.error(`[${task.issue.identifier}] finalize failed, retrying next tick:`, err instanceof Error ? err.message : err);
		return;
	}

	active.delete(task.issue.identifier);
	deleteTask(task.project, task.name).catch((err) =>
		console.error(`[${task.issue.identifier}] delete task failed:`, err instanceof Error ? err.message : err),
	);
	await notify(config.telegramBotToken, config.telegramChatId, message);
}

function poll(): Promise<void> {
	polling ??= pollOnce().finally(() => {
		polling = null;
	});
	return polling;
}

async function pollOnce(): Promise<void> {
	lastPoll = Date.now();
	let issues: LinearIssue[];
	try {
		issues = await linear.issuesInState(states.trigger);
	} catch (err) {
		console.error("poll failed:", err instanceof Error ? err.message : err);
		return;
	}

	for (const issue of issues) {
		if (active.size >= config.maxConcurrentTasks) break;
		if (active.has(issue.identifier)) continue;
		await dispatch(issue);
	}
}

async function checkActive(): Promise<void> {
	for (const task of [...active.values()]) {
		let status: TaskStatus;
		try {
			status = await getTaskStatus(task.project, task.name);
		} catch (err) {
			console.error(`[${task.issue.identifier}] status check failed:`, err instanceof Error ? err.message : err);
			continue;
		}

		if (!status.running) {
			await finalize(task, { success: false, reason: "agent process exited" });
			continue;
		}

		if (status.endedAt !== null && status.startedAt !== null && status.endedAt > status.startedAt && !status.busy) {
			await finalize(task, { success: true, lastText: status.lastText ?? "", repo: status.repo });
			continue;
		}

		if (Date.now() - task.startedAt > config.taskTimeoutMs) {
			await abortTask(task.project, task.name);
			await finalize(task, {
				success: false,
				reason: `timed out after ${(config.taskTimeoutMs / 3_600_000).toFixed(1)}h (aborted)`,
			});
		}
	}
}

async function recover(): Promise<void> {
	let issues: LinearIssue[];
	try {
		issues = await linear.issuesInStateWithLabel(states.inProgress, config.agentLabel);
	} catch (err) {
		console.error("recovery failed:", err instanceof Error ? err.message : err);
		return;
	}
	for (const issue of issues) {
		const target = resolveTarget(issue);
		if (!target) continue;
		const mode: "code" | "ops" = issue.labels.includes(config.opsLabel) ? "ops" : "code";
		const name = issue.identifier.toLowerCase();
		const key = `${target}-${name}`;
		const startedAt = issue.startedAt ? new Date(issue.startedAt).getTime() : Date.now();
		active.set(issue.identifier, { issue, project: target, mode, key, name, startedAt });
		console.log(`[${issue.identifier}] recovered -> ${target} (${mode})`);
	}
}

async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		if (Date.now() - lastPoll >= config.pollIntervalMs) await poll();
		await checkActive();
	} catch (err) {
		console.error("tick failed:", err instanceof Error ? err.message : err);
	} finally {
		ticking = false;
	}
}

function startServer(): void {
	Bun.serve({
		hostname: "0.0.0.0",
		port: config.port,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/health_check") return json({ status: "ok" });

			if (path === "/tasks" && req.method === "GET") {
				return json(
					[...active.values()].map((t) => ({
						identifier: t.issue.identifier,
						title: t.issue.title,
						project: t.project,
						mode: t.mode,
						key: t.key,
						startedAt: t.startedAt,
						url: t.issue.url,
					})),
				);
			}

			if (path === "/poll" && req.method === "POST") {
				const before = active.size;
				await poll();
				return json({ ok: true, dispatched: active.size - before });
			}

			if (path === "/tickets" && req.method === "POST") {
				const body = await readBody(req);
				const project = body.project as string | undefined;
				const title = body.title as string | undefined;
				if (!project || !allowedProjects.includes(project)) {
					return json({ error: `project not allowed: ${project}` }, 400);
				}
				if (!title) return json({ error: "title is required" }, 400);
				const ops = body.ops === true;
				const description = (body.description as string | undefined) ?? "";
				const labelIds = [await linear.ensureLabel(team.id, project)];
				if (ops) labelIds.push(await linear.ensureLabel(team.id, config.opsLabel));
				const issue = await linear.createIssue({
					teamId: team.id,
					title,
					description,
					stateId: states.trigger,
					labelIds,
				});
				void poll();
				return json({ identifier: issue.identifier, url: issue.url });
			}

			const abortMatch = path.match(/^\/tasks\/([^/]+)\/abort$/);
			if (abortMatch && req.method === "POST") {
				const identifier = decodeURIComponent(abortMatch[1]);
				const task = active.get(identifier);
				if (!task) return json({ error: "not active" }, 404);
				await abortTask(task.project, task.name);
				await finalize(task, { success: false, reason: "aborted by operator" });
				return json({ ok: true });
			}

			return json({ error: "not found" }, 404);
		},
	});
	console.log(`linear-connector listening on http://0.0.0.0:${config.port}`);
}

async function main(): Promise<void> {
	allowedProjects = await waitForHostRunner();
	console.log(`host-runner projects: ${allowedProjects.join(", ")}`);

	team = await linear.getTeam(config.teamKey);
	const triggerId = await linear.ensureState(team.id, config.triggerState, "#8b5cf6");
	const failedId = await linear.ensureState(team.id, config.failedState, "#ef4444");
	const inProgress = team.states.find((s) => s.name === config.inProgressState);
	const review = team.states.find((s) => s.name === config.reviewState);
	const done = team.states.find((s) => s.name === config.doneState);
	if (!inProgress || !review || !done) {
		throw new Error(
			`States "${config.inProgressState}"/"${config.reviewState}"/"${config.doneState}" not found in team ${config.teamKey}`,
		);
	}
	states = { trigger: triggerId, inProgress: inProgress.id, review: review.id, done: done.id, failed: failedId };
	await linear.ensureLabel(team.id, config.agentLabel);

	await recover();
	startServer();
	setInterval(tick, config.tickMs);
	console.log(`ticking every ${config.tickMs}ms, polling every ${config.pollIntervalMs}ms`);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
