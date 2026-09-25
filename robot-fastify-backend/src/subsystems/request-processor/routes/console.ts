import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../../config";
import type { AgentManager } from "../../agent-manager/index";

async function fetchJson<T>(url: string): Promise<T | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

export function registerConsoleRoutes(
	app: FastifyInstance,
	agentManager: AgentManager,
	config: Config,
) {
	const serveConsole = (_req: unknown, reply: import("fastify").FastifyReply) => {
		const file = join(config.consoleDir, "index.html");
		if (!existsSync(file)) {
			return reply.status(404).send("web console not found");
		}
		return reply
			.header("content-type", "text/html; charset=utf-8")
			.send(readFileSync(file, "utf-8"));
	};

	// Homepage: the console (with the Poop House view selected by default)
	// lives at the site root as well as /console.
	app.get("/", serveConsole);
	app.get("/console", serveConsole);

	app.get("/api/overview", async () => {
		const [projects, health, hostSystem, credits, tasks] = await Promise.all([
			fetchJson<{ allowed: string[]; running: string[] }>(
				`${config.hostRunnerUrl}/projects`,
			),
			fetchJson<{ overall: string; checks: unknown[] }>(
				`${config.healthUrl}/health`,
			),
			fetchJson<{
				mem: { free: number; total: number };
				disk: { free: number; total: number };
			}>(`${config.hostRunnerUrl}/system`),
			fetchJson<{
				provider: string;
				available: boolean;
				total?: number;
				usage?: number;
				remaining?: number;
			}>(`${config.hostRunnerUrl}/credits`),
			fetchJson<
				Array<{
					identifier: string;
					title: string;
					project: string;
					mode: string;
					key: string;
					startedAt: number;
					url: string;
				}>
			>(`${config.linearUrl}/tasks`),
		]);
		return {
			system: { uptime: agentManager.getStatus().uptime },
			hostProjects: projects ?? { allowed: [], running: [] },
			hostSystem: hostSystem ?? null,
			health: health ?? { overall: "unreachable", checks: [] },
			credits: credits ?? null,
			tasks: tasks ?? [],
		};
	});

	app.post<{ Params: { project: string } }>(
		"/api/host/:project/prompt",
		async (req, reply) => {
			const res = await fetch(
				`${config.hostRunnerUrl}/projects/${encodeURIComponent(req.params.project)}/prompt`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(req.body ?? {}),
					signal: AbortSignal.timeout(15000),
				},
			);
			reply.status(res.status);
			return (await res.json().catch(() => ({ ok: false }))) as unknown;
		},
	);

	app.post<{ Params: { project: string } }>(
		"/api/host/:project/restart",
		async (req, reply) => {
			const res = await fetch(
				`${config.hostRunnerUrl}/projects/${encodeURIComponent(req.params.project)}/restart`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(15000),
				},
			);
			reply.status(res.status);
			return (await res.json().catch(() => ({ ok: false }))) as unknown;
		},
	);

	app.post<{ Params: { project: string } }>(
		"/api/health/:project/recheck",
		async (req, reply) => {
			const res = await fetch(
				`${config.healthUrl}/check/${encodeURIComponent(req.params.project)}`,
				{ method: "POST", signal: AbortSignal.timeout(15000) },
			);
			reply.status(res.status);
			return (await res.json().catch(() => ({ ok: false }))) as unknown;
		},
	);
}
