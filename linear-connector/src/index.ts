import { loadConfig, validateConfig } from "./config";
import { LinearClient } from "./linear";

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length > 0) {
	console.error("Invalid config:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

const linear = new LinearClient(config.linearApiKey);

let allowedProjects: string[] = [];
const pendingCompletion = new Map<string, (text: string) => void>();

function connectHostRunner(): void {
	const ws = new WebSocket(config.hostRunnerWsUrl);
	ws.onopen = () => console.log(`connected to host-runner ${config.hostRunnerWsUrl}`);
	ws.onmessage = (ev) => {
		try {
			const msg = JSON.parse(ev.data as string);
			if (msg.type === "message_complete" && typeof msg.project === "string") {
				pendingCompletion.get(msg.project)?.(String(msg.data ?? ""));
			}
		} catch {
			// ignore
		}
	};
	ws.onclose = () => {
		console.warn("host-runner WS closed; reconnecting in 3s");
		setTimeout(connectHostRunner, 3000);
	};
	ws.onerror = () => ws.close();
}

function taskId(project: string, branch: string): string {
	return `${project}-${branch.replace(/\//g, "-")}`;
}

function branchFor(identifier: string): string {
	return identifier.toLowerCase();
}

async function runTaskOnHostRunner(
	project: string,
	branch: string,
	task: string,
): Promise<string> {
	const key = taskId(project, branch);
	const completion = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingCompletion.delete(key);
			reject(new Error("agent timed out"));
		}, config.promptTimeoutMs);
		pendingCompletion.set(key, (text) => {
			clearTimeout(timer);
			pendingCompletion.delete(key);
			resolve(text);
		});
	});

	const res = await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/task`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: task, branch }),
	});
	if (!res.ok) {
		pendingCompletion.delete(key);
		throw new Error(`host-runner task failed (${res.status})`);
	}
	return completion;
}

async function cleanupTask(project: string, branch: string): Promise<void> {
	try {
		await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/task`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ branch }),
		});
	} catch {
		// best-effort; the branch is already pushed
	}
}

function pickTarget(issue: { project: string | null; labels: string[] }): string | undefined {
	if (issue.project && allowedProjects.includes(issue.project)) return issue.project;
	return issue.labels.find((l) => allowedProjects.includes(l));
}

async function processIssue(
	issue: {
		id: string;
		identifier: string;
		title: string;
		description: string;
		labels: string[];
		project: string | null;
	},
	inProgressId: string,
	reviewId: string,
): Promise<void> {
	const target = pickTarget(issue);
	if (!target) {
		await linear.moveIssue(issue.id, inProgressId);
		await linear.comment(
			issue.id,
			`🤖 No target repo. Put me in a Linear project (or label me) matching one of: ${allowedProjects.join(", ")}, then move me back to the agent queue.`,
		);
		return;
	}

	const branch = branchFor(issue.identifier);
	await linear.moveIssue(issue.id, inProgressId);
	await linear.comment(issue.id, `🤖 Agent started in \`${target}\` on branch \`${branch}\`.`);
	console.log(`[${issue.identifier}] -> ${target} (${branch}): ${issue.title}`);

	const task = [
		`Linear issue ${issue.identifier}: ${issue.title}`,
		"",
		issue.description || "(no description)",
		"",
		`You are in a dedicated git worktree on a new branch \`${branch}\` — not on the main branch.`,
		"Implement the change here, then commit it and push the branch:",
		`  git push -u origin ${branch}`,
		"Then open a pull request against the default branch: use `gh pr create` if available,",
		"otherwise create it via the GitHub REST API using the $GITHUB_TOKEN environment variable.",
		"When finished, summarize what you changed and include the pull request URL.",
	].join("\n");

	try {
		const result = await runTaskOnHostRunner(target, branch, task);
		await linear.comment(issue.id, result || "(agent produced no text output)");
		await linear.moveIssue(issue.id, reviewId);
		await cleanupTask(target, branch);
		console.log(`[${issue.identifier}] done -> In Review`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "unknown error";
		await linear.comment(issue.id, `❌ Agent failed: ${msg}`);
		console.error(`[${issue.identifier}] failed: ${msg}`);
	}
}

async function main(): Promise<void> {
	const projectsRes = await fetch(`${config.hostRunnerUrl}/projects`);
	allowedProjects = ((await projectsRes.json()) as { allowed: string[] }).allowed;
	console.log(`host-runner projects: ${allowedProjects.join(", ")}`);

	const team = await linear.getTeam(config.teamKey);
	const triggerId = await linear.ensureState(team.id, config.triggerState, "#8b5cf6");
	const inProgress = team.states.find((s) => s.name === config.inProgressState);
	const review = team.states.find((s) => s.name === config.reviewState);
	if (!inProgress || !review) {
		throw new Error(
			`States "${config.inProgressState}"/"${config.reviewState}" not found in team ${config.teamKey}`,
		);
	}
	console.log(`trigger state "${config.triggerState}" = ${triggerId}`);

	connectHostRunner();

	const poll = async () => {
		try {
			const issues = await linear.issuesInState(triggerId);
			for (const issue of issues) {
				await processIssue(issue, inProgress.id, review.id);
			}
		} catch (err) {
			console.error("poll error:", err instanceof Error ? err.message : err);
		}
		setTimeout(poll, config.pollIntervalMs);
	};
	poll();
	console.log(`polling every ${config.pollIntervalMs}ms`);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
