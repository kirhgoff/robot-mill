/**
 * GET /status — detailed system status from the agent manager.
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../../agent-manager/index";

export function registerStatusRoutes(
	app: FastifyInstance,
	agentManager: AgentManager,
) {
	app.get("/status", async (_req, reply) => {
		const status = agentManager.getStatus();
		return reply.send(status);
	});
}
