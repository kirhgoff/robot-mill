/**
 * PiAgent — wraps a single `pi --mode rpc` child process.
 *
 * Handles JSONL event parsing, session persistence, and emits typed events.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AgentInfo, AgentOutput, AgentStatus } from "../../types/agent";

export interface PiAgentOptions {
	id: string;
	name: string;
	cwd: string;
	sessionDir: string;
	provider?: string;
	model?: string;
	tools?: string;
	systemPrompt?: string;
	resumeSession?: boolean;
	env?: Record<string, string>;
}

export class PiAgent extends EventEmitter {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;

	private proc: ChildProcess | null = null;
	private buffer = "";
	private pendingText = "";
	private _status: AgentStatus = "idle";
	private _currentTask = "";
	private _createdAt = Date.now();
	private _lastActivityAt = Date.now();
	private readonly sessionFile: string;
	private readonly options: PiAgentOptions;

	constructor(options: PiAgentOptions) {
		super();
		this.id = options.id;
		this.name = options.name;
		this.cwd = options.cwd;
		this.options = options;

		// Ensure session directory exists
		if (!existsSync(options.sessionDir)) {
			mkdirSync(options.sessionDir, { recursive: true });
		}
		this.sessionFile = join(options.sessionDir, `${this.id}.json`);
	}

	/** Spawn the pi process in RPC mode. */
	start(): void {
		if (this.proc) {
			throw new Error(`Agent ${this.id} is already running`);
		}

		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.tools) {
			args.push("--tools", this.options.tools);
		}
		if (this.options.systemPrompt) {
			args.push("--append-system-prompt", this.options.systemPrompt);
		}

		// Session persistence
		args.push("--session", this.sessionFile);
		if (this.options.resumeSession && existsSync(this.sessionFile)) {
			args.push("-c");
		}

		const env = { ...process.env, ...this.options.env };

		this.proc = spawn("pi", args, {
			cwd: this.cwd,
			env,
		});

		this.proc.stdout!.setEncoding("utf-8");
		this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));

		this.proc.stderr!.setEncoding("utf-8");
		this.proc.stderr!.on("data", (chunk: string) => {
			const text = chunk.trim();
			if (text) {
				this.emitOutput("error", text);
			}
		});

		this.proc.on("close", (code) => {
			this.proc = null;
			this._status = "stopped";
			this.emitOutput("status_change", {
				status: "stopped",
				exitCode: code,
			});
			this.emit("exit", code);
		});

		this.proc.on("error", (err) => {
			this._status = "error";
			this.emitOutput("error", err.message);
			this.emit("error", err);
		});

		this._status = "idle";
		this.emitOutput("status_change", { status: "idle" });
	}

	/** Send a user prompt to the pi process. */
	prompt(message: string): void {
		this._currentTask = message;
		this._lastActivityAt = Date.now();
		this.write({ type: "prompt", message });
	}

	/** Abort the current operation. */
	abort(): void {
		this.write({ type: "abort" });
	}

	/** Start a new conversation (keeps process alive). */
	newSession(): void {
		this.write({ type: "new_session" });
		this._currentTask = "";
		this.pendingText = "";
	}

	/** Kill the underlying process. */
	kill(): void {
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {
				// ignore
			}
		}
	}

	/** Whether the process is alive. */
	get alive(): boolean {
		return this.proc !== null;
	}

	get status(): AgentStatus {
		return this._status;
	}

	get hasSession(): boolean {
		return existsSync(this.sessionFile);
	}

	/** Return a serialisable snapshot. */
	toInfo(): AgentInfo {
		return {
			id: this.id,
			name: this.name,
			runtime: "pi",
			status: this._status,
			cwd: this.cwd,
			currentTask: this._currentTask,
			createdAt: this._createdAt,
			lastActivityAt: this._lastActivityAt,
			hasSession: this.hasSession,
			meta: {},
		};
	}

	// ── Private ──────────────────────────────────────────────

	private write(obj: Record<string, unknown>): void {
		if (!this.proc?.stdin?.writable) return;
		try {
			this.proc.stdin.write(JSON.stringify(obj) + "\n");
		} catch {
			// ignore
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				this.handleEvent(JSON.parse(line));
			} catch {
				// malformed line
			}
		}
	}

	private handleEvent(event: Record<string, unknown>): void {
		// Always emit the raw event for pass-through
		this.emitOutput("raw_event", event);

		switch (event.type) {
			case "agent_start":
				this._status = "running";
				this.pendingText = "";
				this.emitOutput("status_change", { status: "running" });
				break;

			case "message_update": {
				const mev = event.assistantMessageEvent as
					| Record<string, unknown>
					| undefined;
				if (mev?.type === "text_delta") {
					this.pendingText += mev.delta as string;
					this.emitOutput("text", mev.delta);
				}
				break;
			}

			case "agent_end":
				this._status = "idle";
				if (this.pendingText.trim()) {
					// Emit the full accumulated text as a complete message
					this.emit("message_complete", this.pendingText.trim());
				}
				this.pendingText = "";
				this.emitOutput("status_change", { status: "idle" });
				break;

			case "tool_execution_start":
				this.emitOutput("tool_start", {
					toolName: event.toolName,
					args: event.args,
				});
				break;

			case "tool_execution_end":
				this.emitOutput("tool_end", {
					toolName: event.toolName,
				});
				break;

			case "extension_ui_request":
				this.handleExtensionUI(event as Record<string, unknown>);
				break;

			default:
				break;
		}
	}

	private handleExtensionUI(req: Record<string, unknown>): void {
		// Auto-respond to extension UI requests for now
		if (req.method === "confirm") {
			this.write({
				type: "extension_ui_response",
				id: req.id,
				confirmed: true,
			});
		} else if (req.method === "select") {
			const options = req.options as string[] | undefined;
			this.write({
				type: "extension_ui_response",
				id: req.id,
				value: options?.[0],
			});
		} else if (req.method === "input") {
			this.write({
				type: "extension_ui_response",
				id: req.id,
				value: "",
			});
		}
	}

	private emitOutput(type: string, data: unknown): void {
		const output: AgentOutput = {
			type: type as AgentOutput["type"],
			agentId: this.id,
			timestamp: Date.now(),
			data,
		};
		this.emit("output", output);
	}
}
