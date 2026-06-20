/**
 * BackendClient — HTTP + WebSocket client for robot-fastify-backend.
 *
 * Frontends (Telegram, WhatsApp, custom) use this to talk to the backend.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface BackendClientOptions {
	/** e.g. "http://localhost:3100" */
	baseUrl: string;
	/** e.g. "ws://localhost:3100/ws" */
	wsUrl: string;
	/** Auto-reconnect WebSocket on disconnect */
	autoReconnect?: boolean;
	/** Reconnect interval in ms */
	reconnectInterval?: number;
}

export interface AgentInfo {
	id: string;
	name: string;
	runtime: string;
	status: string;
	cwd: string;
	currentTask: string;
	createdAt: number;
	lastActivityAt: number;
	hasSession: boolean;
	meta: Record<string, unknown>;
}

export interface SystemStatus {
	uptime: number;
	agentCount: number;
	agents: AgentInfo[];
	sessionStoragePath: string;
}

export interface SpawnRequest {
	name: string;
	cwd?: string;
	provider?: string;
	model?: string;
	tools?: string;
	systemPrompt?: string;
	sessionId?: string;
	resumeSession?: boolean;
}

export class BackendClient extends EventEmitter {
	private ws: WebSocket | null = null;
	private opts: Required<BackendClientOptions>;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private intentionalClose = false;

	constructor(options: BackendClientOptions) {
		super();
		this.opts = {
			autoReconnect: true,
			reconnectInterval: 3000,
			...options,
		};
	}

	// ── HTTP helpers ─────────────────────────────────

	async healthCheck(): Promise<{ status: string }> {
		return this.get("/health_check");
	}

	async getStatus(): Promise<SystemStatus> {
		return this.get("/status");
	}

	async listAgents(): Promise<AgentInfo[]> {
		return this.get("/agents");
	}

	async getAgent(id: string): Promise<AgentInfo> {
		return this.get(`/agents/${id}`);
	}

	async spawnAgent(request: SpawnRequest): Promise<AgentInfo> {
		return this.post("/agents", request);
	}

	async promptAgent(
		agentId: string,
		message: string,
	): Promise<{ ok: boolean }> {
		return this.post(`/agents/${agentId}/prompt`, { message });
	}

	async abortAgent(agentId: string): Promise<{ ok: boolean }> {
		return this.post(`/agents/${agentId}/abort`, {});
	}

	async newSession(agentId: string): Promise<{ ok: boolean }> {
		return this.post(`/agents/${agentId}/new-session`, {});
	}

	async killAgent(agentId: string): Promise<{ ok: boolean }> {
		const res = await fetch(`${this.opts.baseUrl}/agents/${agentId}`, {
			method: "DELETE",
		});
		return res.json() as Promise<{ ok: boolean }>;
	}

	// ── WebSocket ────────────────────────────────────

	/** Connect WebSocket and subscribe to all agent events. */
	connect(): void {
		this.intentionalClose = false;
		this.ws = new WebSocket(this.opts.wsUrl);

		this.ws.on("open", () => {
			this.emit("ws:connected");
			// Subscribe to all agents
			this.wsSend({ action: "subscribe_all" });
		});

		this.ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				this.emit("ws:message", msg);

				// Emit typed events for convenience
				if (msg.type === "message_complete") {
					this.emit("agent:message_complete", msg.agentId, msg.data);
				} else if (msg.type === "agent_exit") {
					this.emit("agent:exit", msg.agentId, msg.data?.code);
				} else if (msg.type) {
					this.emit(`agent:${msg.type}`, msg);
				}
			} catch {
				// ignore
			}
		});

		this.ws.on("close", () => {
			this.emit("ws:disconnected");
			if (this.opts.autoReconnect && !this.intentionalClose) {
				this.scheduleReconnect();
			}
		});

		this.ws.on("error", (err) => {
			this.emit("ws:error", err);
		});
	}

	/** Disconnect WebSocket. */
	disconnect(): void {
		this.intentionalClose = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	/** Send a WS command to subscribe to a specific agent. */
	subscribe(agentId: string): void {
		this.wsSend({ action: "subscribe", agentId });
	}

	/** Send a raw WS message (prompt, abort, spawn, kill via WS). */
	wsSend(data: Record<string, unknown>): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		}
	}

	// ── Private ──────────────────────────────────────

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.opts.reconnectInterval);
	}

	private async get<T>(path: string): Promise<T> {
		const res = await fetch(`${this.opts.baseUrl}${path}`);
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`GET ${path} failed (${res.status}): ${body}`);
		}
		return res.json() as Promise<T>;
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const res = await fetch(`${this.opts.baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`POST ${path} failed (${res.status}): ${text}`);
		}
		return res.json() as Promise<T>;
	}
}
