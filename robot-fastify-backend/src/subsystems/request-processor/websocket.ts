/**
 * WebSocket handler — real-time bidirectional communication with agents.
 *
 * Clients connect to /ws and can:
 *   - Subscribe to agent output:  { "action": "subscribe", "agentId": "..." }
 *   - Unsubscribe:                { "action": "unsubscribe", "agentId": "..." }
 *   - Subscribe to all agents:    { "action": "subscribe_all" }
 *   - Send a prompt:              { "action": "prompt", "agentId": "...", "message": "..." }
 *   - Abort:                      { "action": "abort", "agentId": "..." }
 *   - Spawn an agent:             { "action": "spawn", ...SpawnAgentRequest }
 *   - Kill an agent:              { "action": "kill", "agentId": "..." }
 *
 * The server pushes AgentOutput events to subscribed clients.
 */

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { AgentManager } from "../agent-manager/index";
import type { AgentOutput, SpawnAgentRequest } from "../../types/agent";

interface WsClient {
	socket: WebSocket;
	/** Agent IDs this client is subscribed to. Empty set + subscribeAll = get everything. */
	subscriptions: Set<string>;
	subscribeAll: boolean;
}

export function registerWebSocket(
	app: FastifyInstance,
	agentManager: AgentManager,
) {
	const clients = new Set<WsClient>();

	// Forward agent output to subscribed WS clients
	agentManager.on("agent:output", (output: AgentOutput) => {
		const payload = JSON.stringify(output);
		for (const client of clients) {
			if (client.subscribeAll || client.subscriptions.has(output.agentId)) {
				try {
					client.socket.send(payload);
				} catch {
					// dead socket, will be cleaned up on close
				}
			}
		}
	});

	agentManager.on(
		"agent:message_complete",
		(event: { agentId: string; text: string }) => {
			const payload = JSON.stringify({
				type: "message_complete",
				agentId: event.agentId,
				timestamp: Date.now(),
				data: event.text,
			});
			for (const client of clients) {
				if (client.subscribeAll || client.subscriptions.has(event.agentId)) {
					try {
						client.socket.send(payload);
					} catch {
						// ignore
					}
				}
			}
		},
	);

	agentManager.on(
		"agent:exit",
		(event: { agentId: string; code: number | null }) => {
			const payload = JSON.stringify({
				type: "agent_exit",
				agentId: event.agentId,
				timestamp: Date.now(),
				data: { code: event.code },
			});
			for (const client of clients) {
				if (client.subscribeAll || client.subscriptions.has(event.agentId)) {
					try {
						client.socket.send(payload);
					} catch {
						// ignore
					}
				}
			}
		},
	);

	app.get("/ws", { websocket: true }, (socket, _req) => {
		const client: WsClient = {
			socket,
			subscriptions: new Set(),
			subscribeAll: false,
		};
		clients.add(client);

		socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				socket.send(JSON.stringify({ error: "invalid JSON" }));
				return;
			}

			try {
				handleClientMessage(client, msg, agentManager);
			} catch (err) {
				socket.send(
					JSON.stringify({
						error: err instanceof Error ? err.message : "unknown error",
					}),
				);
			}
		});

		socket.on("close", () => {
			clients.delete(client);
		});
	});
}

function handleClientMessage(
	client: WsClient,
	msg: Record<string, unknown>,
	agentManager: AgentManager,
): void {
	const action = msg.action as string;
	const agentId = msg.agentId as string | undefined;

	switch (action) {
		case "subscribe":
			if (agentId) client.subscriptions.add(agentId);
			client.socket.send(
				JSON.stringify({
					ack: "subscribed",
					agentId,
				}),
			);
			break;

		case "unsubscribe":
			if (agentId) client.subscriptions.delete(agentId);
			client.socket.send(
				JSON.stringify({
					ack: "unsubscribed",
					agentId,
				}),
			);
			break;

		case "subscribe_all":
			client.subscribeAll = true;
			client.socket.send(JSON.stringify({ ack: "subscribed_all" }));
			break;

		case "prompt":
			if (!agentId || !msg.message) {
				throw new Error("agentId and message required");
			}
			agentManager.prompt(agentId, msg.message as string);
			client.socket.send(JSON.stringify({ ack: "prompted", agentId }));
			break;

		case "abort":
			if (!agentId) throw new Error("agentId required");
			agentManager.abort(agentId);
			client.socket.send(JSON.stringify({ ack: "aborted", agentId }));
			break;

		case "spawn": {
			const info = agentManager.spawn(msg as unknown as SpawnAgentRequest);
			// Auto-subscribe to the new agent
			client.subscriptions.add(info.id);
			client.socket.send(JSON.stringify({ ack: "spawned", agent: info }));
			break;
		}

		case "kill":
			if (!agentId) throw new Error("agentId required");
			agentManager.kill(agentId);
			client.subscriptions.delete(agentId);
			client.socket.send(JSON.stringify({ ack: "killed", agentId }));
			break;

		case "status":
			client.socket.send(
				JSON.stringify({
					ack: "status",
					data: agentManager.getStatus(),
				}),
			);
			break;

		default:
			throw new Error(`Unknown action: ${action}`);
	}
}
