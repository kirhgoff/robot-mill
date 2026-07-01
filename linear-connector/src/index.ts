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

async function runOnHostRunner(project: string, task: string): Promise<string> {
	const completion = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingCompletion.delete(project);
			reject(new Error("agent timed out"));
		}, config.promptTimeoutMs);
		pendingCompletion.set(project, (text) => {
			clearTimeout(timer);
			pendingCompletion.delete(project);
			resolve(text);
		});
	});

	const res = await fetch(`${config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: task }),
	});
	if (!res.ok) {
		pendingCompletion.delete(project);
		throw new Error(`host-runner prompt failed (${res.status})`);
	}
	return completion;
}

function pickTarget(labels: string[]): string | undefined {
	return labels.find((l) => allowedProjects.includes(l));
}

async function processIssue(
	issue: { id: string; identifier: string; title: string; description: string; labels: string[] },
	inProgressId: string,
	reviewId: string,
): Promise<void> {
	const target = pickTarget(issue.labels);
	if (!target) {
		await linear.moveIssue(issue.id, inProgressId);
		await linear.comment(
			issue.id,
			`🤖 No target project label. Add a label matching one of: ${allowedProjects.join(", ")}, then move me back to the agent queue.`,
		);
		return;
	}

	await linear.moveIssue(issue.id, inProgressId);
	await linear.comment(issue.id, `🤖 Agent started in \`${target}\`.`);
	console.log(`[${issue.identifier}] -> ${target}: ${issue.title}`);

	const task = [
		`Linear issue ${issue.identifier}: ${issue.title}`,
		"",
		issue.description || "(no description)",
		"",
		"Work on this in the current project. When finished, summarize what you changed and any follow-ups.",
	].join("\n");

	try {
		const result = await runOnHostRunner(target, task);
		await linear.comment(issue.id, result || "(agent produced no text output)");
		await linear.moveIssue(issue.id, reviewId);
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
