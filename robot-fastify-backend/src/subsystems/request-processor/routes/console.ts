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
	app.get("/console", async (_req, reply) => {
		const file = join(config.consoleDir, "index.html");
		if (!existsSync(file)) {
			return reply.status(404).send("web console not found");
		}
		return reply
			.header("content-type", "text/html; charset=utf-8")
			.send(readFileSync(file, "utf-8"));
	});

	app.get("/api/overview", async () => {
		const [projects, health] = await Promise.all([
			fetchJson<{ allowed: string[]; running: string[] }>(
				`${config.hostRunnerUrl}/projects`,
			),
			fetchJson<{ overall: string; checks: unknown[] }>(
				`${config.healthUrl}/health`,
			),
		]);
		return {
			agents: agentManager.listAgents(),
			system: agentManager.getStatus(),
			hostProjects: projects ?? { allowed: [], running: [] },
			health: health ?? { overall: "unreachable", checks: [] },
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
				},
			);
			reply.status(res.status);
			return (await res.json().catch(() => ({ ok: false }))) as unknown;
		},
	);
}
