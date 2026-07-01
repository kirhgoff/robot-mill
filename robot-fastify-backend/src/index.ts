/**
 * robot-fastify-backend — Agent orchestration server.
 *
 * Subsystems:
 *   - AgentManager:        spawn / track / control pi agent processes
 *   - VariationManager:    site variation lifecycle (worktrees, dev servers)
 *   - RequestProcessor:    REST + WebSocket API (Fastify)
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { loadConfig, validateConfig } from "./config";
import { AgentManager } from "./subsystems/agent-manager";
import { VariationManager } from "./subsystems/variation-manager";
import { registerRequestProcessor } from "./subsystems/request-processor";

async function main() {
	const config = loadConfig();
	const errors = validateConfig(config);
	if (errors.length > 0) {
		console.error("Config validation failed:");
		for (const e of errors) {
			console.error(`  ✗ ${e.field}: ${e.message}`);
		}
		process.exit(1);
	}

	const app = Fastify({
		logger: {
			level: config.logLevel,
			transport:
				process.env.NODE_ENV !== "production"
					? { target: "pino-pretty" }
					: undefined,
		},
	});

	// ── Plugins ────────────────────────────────────
	await app.register(websocket);
	await app.register(cors, {
		origin: true, // Allow the web frontend
	});

	// ── Subsystems ─────────────────────────────────
	const agentManager = new AgentManager(config);
	const variationManager = new VariationManager(config, agentManager);
	registerRequestProcessor(app, agentManager, variationManager, config);

	// ── Graceful shutdown ──────────────────────────
	const shutdown = async () => {
		app.log.info("Shutting down — stopping all dev servers and agents");
		variationManager.shutdown();
		agentManager.killAll();
		await app.close();
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// ── Start ──────────────────────────────────────
	await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
