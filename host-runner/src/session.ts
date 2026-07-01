import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { hasSession, killSession, newSession } from "./tmux";

const bunPath = process.execPath;
const bridgePath = join(import.meta.dir, "bridge.ts");

export interface SessionOutput {
	project: string;
	type: string;
	data: unknown;
	timestamp: number;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export class PiSession extends EventEmitter {
	readonly project: string;
	private readonly dir: string;
	private readonly socketPath: string;
	private readonly sessionFile: string;
	private readonly config: Config;
	private socket: Socket | null = null;
	private buffer = "";
	private pendingText = "";
	private connecting: Promise<void> | null = null;

	constructor(project: string, dir: string, config: Config) {
		super();
		this.project = project;
		this.dir = dir;
		this.config = config;
		this.socketPath = join(config.stateDir, "sockets", `${project}.sock`);
		this.sessionFile = join(config.stateDir, "sessions", `${project}.json`);
	}

	async ensure(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		if (this.connecting) return this.connecting;
		this.connecting = this.doEnsure();
		try {
			await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	private async doEnsure(): Promise<void> {
		if (!hasSession(this.project)) {
			const command = [
				shellQuote(bunPath),
				"run",
				shellQuote(bridgePath),
				"--dir",
				shellQuote(this.dir),
				"--socket",
				shellQuote(this.socketPath),
				"--session",
				shellQuote(this.sessionFile),
				"--provider",
				shellQuote(this.config.piProvider),
			];
			if (this.config.piModel) {
				command.push("--model", shellQuote(this.config.piModel));
			}
			const envVars: Record<string, string> = {
				PATH: process.env.PATH ?? "",
				PI_PROVIDER: this.config.piProvider,
				PI_MODEL: this.config.piModel,
				[this.config.providerKeyEnv]: process.env[this.config.providerKeyEnv] ?? "",
			};
			if (this.config.githubToken) {
				envVars.GITHUB_TOKEN = this.config.githubToken;
				envVars.GIT_CONFIG_COUNT = "1";
				envVars.GIT_CONFIG_KEY_0 = `url.https://${this.config.githubToken}@github.com/.insteadOf`;
				envVars.GIT_CONFIG_VALUE_0 = "https://github.com/";
			}
			newSession(this.project, this.dir, command.join(" "), envVars);
		}
		await this.connectSocket();
	}

	private async connectSocket(): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(this.socketPath)) {
				await new Promise<void>((resolve, reject) => {
					const sock = connect(this.socketPath);
					sock.once("connect", () => {
						this.attach(sock);
						resolve();
					});
					sock.once("error", reject);
				}).catch(() => undefined);
				if (this.socket && !this.socket.destroyed) return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error(`could not connect to bridge socket for ${this.project}`);
	}

	private attach(sock: Socket): void {
		this.socket = sock;
		sock.setEncoding("utf-8");
		sock.on("data", (chunk: string) => this.onData(chunk));
		sock.on("close", () => {
			this.socket = null;
			this.emitOutput("status_change", { status: "disconnected" });
		});
		sock.on("error", () => undefined);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).replace(/\r$/, "");
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				this.handleEvent(JSON.parse(line));
			} catch {
				// malformed line
			}
		}
	}

	private handleEvent(event: Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				this.pendingText = "";
				this.emitOutput("status_change", { status: "running" });
				break;
			case "message_update": {
				const mev = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (mev?.type === "text_delta") {
					this.pendingText += mev.delta as string;
					this.emitOutput("text", mev.delta);
				}
				break;
			}
			case "agent_end":
				if (this.pendingText.trim()) {
					this.emit("message_complete", this.pendingText.trim());
					this.emitOutput("message_complete", this.pendingText.trim());
				}
				this.pendingText = "";
				this.emitOutput("status_change", { status: "idle" });
				break;
			case "tool_execution_start":
				this.emitOutput("tool_start", { toolName: event.toolName, args: event.args });
				break;
			case "tool_execution_end":
				this.emitOutput("tool_end", { toolName: event.toolName });
				break;
			case "extension_ui_request":
				this.respondExtensionUI(event);
				break;
		}
	}

	private respondExtensionUI(req: Record<string, unknown>): void {
		if (req.method === "confirm") {
			this.write({ type: "extension_ui_response", id: req.id, confirmed: true });
		} else if (req.method === "select") {
			const options = req.options as string[] | undefined;
			this.write({ type: "extension_ui_response", id: req.id, value: options?.[0] });
		} else if (req.method === "input") {
			this.write({ type: "extension_ui_response", id: req.id, value: "" });
		}
	}

	prompt(message: string): void {
		this.write({ type: "prompt", message });
	}

	abort(): void {
		this.write({ type: "abort" });
	}

	newConversation(): void {
		this.write({ type: "new_session" });
		this.pendingText = "";
	}

	kill(): void {
		if (this.socket) this.socket.destroy();
		this.socket = null;
		killSession(this.project);
	}

	get running(): boolean {
		return hasSession(this.project);
	}

	private write(obj: Record<string, unknown>): void {
		if (this.socket && !this.socket.destroyed) {
			this.socket.write(`${JSON.stringify(obj)}\n`);
		}
	}

	private emitOutput(type: string, data: unknown): void {
		const output: SessionOutput = {
			project: this.project,
			type,
			data,
			timestamp: Date.now(),
		};
		this.emit("output", output);
	}
}

export class PiSessionManager extends EventEmitter {
	private sessions = new Map<string, PiSession>();
	private config: Config;

	constructor(config: Config) {
		super();
		this.config = config;
	}

	isAllowed(project: string): boolean {
		if (!/^[A-Za-z0-9._-]+$/.test(project)) return false;
		if (this.config.allowedProjects.length > 0) {
			return this.config.allowedProjects.includes(project);
		}
		return existsSync(join(this.config.projectsDir, project));
	}

	listProjects(): string[] {
		return this.config.allowedProjects;
	}

	async get(project: string): Promise<PiSession> {
		let session = this.sessions.get(project);
		if (!session) {
			const dir = join(this.config.projectsDir, project);
			session = new PiSession(project, dir, this.config);
			session.on("output", (output: SessionOutput) => this.emit("output", output));
			session.on("message_complete", (text: string) =>
				this.emit("message_complete", { project, text }),
			);
			this.sessions.set(project, session);
		}
		await session.ensure();
		return session;
	}

	peek(project: string): PiSession | undefined {
		return this.sessions.get(project);
	}

	kill(project: string): void {
		const session = this.sessions.get(project);
		if (session) {
			session.kill();
			this.sessions.delete(project);
		}
	}
}
