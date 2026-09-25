import type { FastifyInstance } from "fastify";
import type { WebSocket as ServerSocket } from "@fastify/websocket";
import WebSocket from "ws";
import type { Config } from "../../config";
import type { AgentManager } from "../agent-manager/index";
import type { AgentOutput } from "../../types/agent";

export function registerConsoleStream(
	app: FastifyInstance,
	agentManager: AgentManager,
	config: Config,
) {
	const clients = new Set<ServerSocket>();

	const broadcast = (payload: unknown) => {
		const data = JSON.stringify(payload);
		for (const client of clients) {
			try {
				client.send(data);
			} catch {
				// dropped on close
			}
		}
	};

	let closed = false;
	let backoffMs = 3000;
	let upstream: WebSocket | null = null;

	const wsUrl = `${config.hostRunnerUrl.replace(/^http/, "ws")}/ws`;
	const connectUpstream = () => {
		if (closed) return;
		upstream = new WebSocket(wsUrl);
		upstream.on("open", () => {
			backoffMs = 3000;
		});
		upstream.on("message", (raw) => {
			try {
				broadcast({ source: "host", ...JSON.parse(raw.toString()) });
			} catch {
				// ignore
			}
		});
		upstream.on("close", () => {
			if (closed) return;
			setTimeout(connectUpstream, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 60000);
		});
		upstream.on("error", () => upstream?.close());
	};
	connectUpstream();

	app.addHook("onClose", async () => {
		closed = true;
		upstream?.close();
	});

	agentManager.on("agent:output", (o: AgentOutput) =>
		broadcast({ source: "agent", type: o.type, agentId: o.agentId, data: o.data }),
	);
	agentManager.on("agent:message_complete", (e: { agentId: string; text: string }) =>
		broadcast({ source: "agent", type: "message_complete", agentId: e.agentId, data: e.text }),
	);

	app.get("/api/stream", { websocket: true }, (socket) => {
		clients.add(socket);
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
	});
}
