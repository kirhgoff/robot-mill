/**
 * GET /health_check — quick liveness probe.
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../../agent-manager/index";

export function registerHealthRoutes(
	app: FastifyInstance,
	agentManager: AgentManager,
) {
	app.get("/health_check", async (_req, reply) => {
		try {
			// Basic sanity: we can reach the agent manager
			agentManager.getStatus();
			return reply.send({ status: "ok" });
		} catch (err) {
			return reply.status(500).send({
				status: "error",
				message: err instanceof Error ? err.message : "unknown",
			});
		}
	});
}
