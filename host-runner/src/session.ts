import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Config, projectKeyValue } from "./config";
import { hasSession, killSession, newSession } from "./tmux";
import { ensureWorktree, removeWorktree, taskId, worktreePath } from "./worktree";

const bunPath = process.execPath;
const bridgePath = join(import.meta.dir, "bridge.ts");

export interface SessionOutput {
	project: string;
	type: string;
	data: unknown;
	timestamp: number;
}

export interface SessionOverride {
	provider?: string;
	model?: string;
	keyEnv?: string;
	keyValue?: string;
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
	private readonly override: SessionOverride;
	private socket: Socket | null = null;
	private buffer = "";
	private pendingText = "";
	private connecting: Promise<void> | null = null;

	constructor(project: string, dir: string, config: Config, override: SessionOverride = {}) {
		super();
		this.project = project;
		this.dir = dir;
		this.config = config;
		this.override = override;
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
			const provider = this.override.provider ?? this.config.piProvider;
			const model = this.override.model ?? this.config.piModel;
			const keyEnv = this.override.keyEnv ?? this.config.providerKeyEnv;
			const keyValue = this.override.keyValue ?? this.config.providerKey;
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
				shellQuote(provider),
			];
			if (model) {
				command.push("--model", shellQuote(model));
			}
			const envVars: Record<string, string> = {
				PATH: process.env.PATH ?? "",
				PI_PROVIDER: provider,
				PI_MODEL: model,
				[keyEnv]: keyValue,
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
					try {
						const sock = connect(this.socketPath);
						sock.once("connect", () => {
							this.attach(sock);
							resolve();
						});
						sock.once("error", reject);
					} catch (err) {
						reject(err);
					}
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
			case "message_end": {
				const message = event.message as Record<string, unknown> | undefined;
				if (
					message?.role === "assistant" &&
					message.stopReason === "error" &&
					typeof message.errorMessage === "string" &&
					message.errorMessage.trim()
				) {
					const errorText = `agent error: ${message.errorMessage}`;
					this.pendingText = errorText;
					this.emitOutput("text", errorText);
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

	async runOnce(message: string, timeoutMs: number): Promise<string> {
		await this.ensure();
		return new Promise<string>((resolve, reject) => {
			const onComplete = (text: string) => {
				cleanup();
				resolve(text);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("diagnosis timed out"));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				this.off("message_complete", onComplete);
			};
			this.once("message_complete", onComplete);
			this.prompt(message);
		});
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
		this.removeSocketFile();
	}

	removeSessionFile(): void {
		try {
			unlinkSync(this.sessionFile);
		} catch {}
	}

	private removeSocketFile(): void {
		try {
			unlinkSync(this.socketPath);
		} catch {}
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
	private diagCounter = 0;

	constructor(config: Config) {
		super();
		this.config = config;
	}

	async diagnose(project: string, message: string, timeoutMs: number): Promise<string> {
		const dir = join(this.config.projectsDir, project);
		const key = `diag-${project}-${++this.diagCounter}`;
		const session = new PiSession(key, dir, this.config, {
			provider: this.config.serviceProvider,
			model: this.config.serviceModel,
			keyEnv: this.config.serviceKeyEnv,
			keyValue: this.config.serviceKey,
		});
		try {
			return await session.runOnce(message, timeoutMs);
		} finally {
			session.kill();
			session.removeSessionFile();
		}
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
		return this.ensureSession(project, join(this.config.projectsDir, project), {
			keyEnv: this.config.providerKeyEnv,
			keyValue: projectKeyValue(this.config, project),
		});
	}

	async getTask(project: string, branch: string): Promise<PiSession> {
		const baseDir = join(this.config.projectsDir, project);
		const dir = worktreePath(this.config.projectsDir, project, branch);
		ensureWorktree(baseDir, dir, branch);
		return this.ensureSession(taskId(project, branch), dir, {
			keyEnv: this.config.providerKeyEnv,
			keyValue: projectKeyValue(this.config, project),
		});
	}

	async restart(project: string): Promise<PiSession> {
		const existing = this.sessions.get(project);
		if (existing) existing.kill();
		else new PiSession(project, join(this.config.projectsDir, project), this.config).kill();
		this.sessions.delete(project);
		return this.get(project);
	}

	killTask(project: string, branch: string): void {
		this.kill(taskId(project, branch));
		removeWorktree(
			join(this.config.projectsDir, project),
			worktreePath(this.config.projectsDir, project, branch),
		);
	}

	private async ensureSession(
		key: string,
		dir: string,
		override: SessionOverride = {},
	): Promise<PiSession> {
		let session = this.sessions.get(key);
		if (!session) {
			session = new PiSession(key, dir, this.config, override);
			session.on("output", (output: SessionOutput) => this.emit("output", output));
			session.on("message_complete", (text: string) =>
				this.emit("message_complete", { project: key, text }),
			);
			this.sessions.set(key, session);
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
