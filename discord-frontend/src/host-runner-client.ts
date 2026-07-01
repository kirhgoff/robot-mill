import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface HostRunnerClientOptions {
	baseUrl: string;
	wsUrl: string;
	autoReconnect?: boolean;
	reconnectInterval?: number;
}

export class HostRunnerClient extends EventEmitter {
	private ws: WebSocket | null = null;
	private opts: Required<HostRunnerClientOptions>;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private intentionalClose = false;

	constructor(options: HostRunnerClientOptions) {
		super();
		this.opts = {
			autoReconnect: true,
			reconnectInterval: 3000,
			...options,
		};
	}

	connect(): void {
		this.intentionalClose = false;
		this.ws = new WebSocket(this.opts.wsUrl);
		this.ws.on("open", () => this.emit("ws:connected"));
		this.ws.on("message", (raw) => {
			try {
				this.emit("ws:message", JSON.parse(raw.toString()));
			} catch {
				// ignore
			}
		});
		this.ws.on("close", () => {
			this.emit("ws:disconnected");
			if (this.opts.autoReconnect && !this.intentionalClose)
				this.scheduleReconnect();
		});
		this.ws.on("error", (err) => this.emit("ws:error", err));
	}

	disconnect(): void {
		this.intentionalClose = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
	}

	async listProjects(): Promise<{ allowed: string[]; running: string[] }> {
		return this.get("/projects");
	}

	async prompt(project: string, message: string): Promise<{ ok: boolean }> {
		return this.post(`/projects/${encodeURIComponent(project)}/prompt`, {
			message,
		});
	}

	async abort(project: string): Promise<{ ok: boolean }> {
		return this.post(`/projects/${encodeURIComponent(project)}/abort`, {});
	}

	async newConversation(project: string): Promise<{ ok: boolean }> {
		return this.post(
			`/projects/${encodeURIComponent(project)}/new-session`,
			{},
		);
	}

	async stop(project: string): Promise<{ ok: boolean }> {
		const res = await fetch(
			`${this.opts.baseUrl}/projects/${encodeURIComponent(project)}`,
			{
				method: "DELETE",
			},
		);
		return res.json() as Promise<{ ok: boolean }>;
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.opts.reconnectInterval);
	}

	private async get<T>(path: string): Promise<T> {
		const res = await fetch(`${this.opts.baseUrl}${path}`);
		if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
		return res.json() as Promise<T>;
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const res = await fetch(`${this.opts.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`POST ${path} failed (${res.status}): ${text}`);
		}
		return res.json() as Promise<T>;
	}
}
