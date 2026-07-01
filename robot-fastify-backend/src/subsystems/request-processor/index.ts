/**
 * RequestProcessor — Fastify plugin that registers all routes and WebSocket.
 */

import type { FastifyInstance } from "fastify";
import type { Config } from "../../config";
import type { AgentManager } from "../agent-manager/index";
import type { VariationManager } from "../variation-manager/index";
import { registerHealthRoutes } from "./routes/health";
import { registerStatusRoutes } from "./routes/status";
import { registerAgentRoutes } from "./routes/agents";
import { registerVariationRoutes } from "./routes/variations";
import { registerConsoleRoutes } from "./routes/console";
import { registerWebSocket } from "./websocket";

export function registerRequestProcessor(
	app: FastifyInstance,
	agentManager: AgentManager,
	variationManager: VariationManager,
	config: Config,
) {
	registerHealthRoutes(app, agentManager);
	registerStatusRoutes(app, agentManager);
	registerAgentRoutes(app, agentManager);
	registerVariationRoutes(app, variationManager);
	registerConsoleRoutes(app, agentManager, config);
	registerWebSocket(app, agentManager);
}
