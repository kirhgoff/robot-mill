/**
 * AgentManager — subsystem for spawning, tracking, and controlling agents.
 *
 * Currently supports pi agents; extensible for other runtimes.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Config } from "../../config";
import type {
	AgentInfo,
	AgentOutput,
	SpawnAgentRequest,
	SystemStatus,
} from "../../types/agent";
import { PiAgent, type PiAgentOptions } from "./pi-agent";

export class AgentManager extends EventEmitter {
	private agents = new Map<string, PiAgent>();
	private startedAt = Date.now();
	private config: Config;

	constructor(config: Config) {
		super();
		this.config = config;

		// Ensure session storage exists
		if (!existsSync(config.sessionStorage)) {
			mkdirSync(config.sessionStorage, { recursive: true });
		}
	}

	/** Spawn a new agent and return its info. */
	spawn(request: SpawnAgentRequest): AgentInfo {
		const id = request.sessionId || nanoid(12);
		const cwd = request.cwd || this.config.workspace;

		if (this.agents.has(id)) {
			throw new Error(`Agent with id "${id}" already exists`);
		}

		const options: PiAgentOptions = {
			id,
			name: request.name,
			cwd,
			sessionDir: this.config.sessionStorage,
			provider: request.provider || this.config.piProvider,
			model: request.model || this.config.piModel || undefined,
			tools: request.tools,
			systemPrompt: request.systemPrompt,
			resumeSession: request.resumeSession,
			env: this.config.anthropicApiKey
				? { ANTHROPIC_API_KEY: this.config.anthropicApiKey }
				: undefined,
		};

		const agent = new PiAgent(options);

		// Forward agent output events to manager-level listeners
		agent.on("output", (output: AgentOutput) => {
			this.emit("agent:output", output);
		});

		agent.on("message_complete", (text: string) => {
			this.emit("agent:message_complete", { agentId: id, text });
		});

		agent.on("exit", (code: number | null) => {
			this.emit("agent:exit", { agentId: id, code });
		});

		agent.on("error", (err: Error) => {
			this.emit("agent:error", { agentId: id, error: err.message });
		});

		agent.start();
		this.agents.set(id, agent);

		return agent.toInfo();
	}

	/** Send a prompt to an existing agent. */
	prompt(agentId: string, message: string): void {
		const agent = this.getAgent(agentId);
		agent.prompt(message);
	}

	/** Abort the current operation on an agent. */
	abort(agentId: string): void {
		const agent = this.getAgent(agentId);
		agent.abort();
	}

	/** Start a new conversation on an agent (keeps process alive). */
	newSession(agentId: string): void {
		const agent = this.getAgent(agentId);
		agent.newSession();
	}

	/** Kill an agent and remove it from tracking. */
	kill(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		agent.kill();
		this.agents.delete(agentId);
	}

	/** Kill all agents. */
	killAll(): void {
		for (const [id, agent] of this.agents) {
			agent.kill();
			this.agents.delete(id);
		}
	}

	/** Get info about a single agent. */
	getAgentInfo(agentId: string): AgentInfo {
		return this.getAgent(agentId).toInfo();
	}

	/** List all running agents. */
	listAgents(): AgentInfo[] {
		return Array.from(this.agents.values()).map((a) => a.toInfo());
	}

	/** Full system status. */
	getStatus(): SystemStatus {
		return {
			uptime: Date.now() - this.startedAt,
			agentCount: this.agents.size,
			agents: this.listAgents(),
			sessionStoragePath: this.config.sessionStorage,
		};
	}

	/** List saved session IDs on disk. */
	listSavedSessions(): string[] {
		try {
			return readdirSync(this.config.sessionStorage)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.replace(/\.json$/, ""));
		} catch {
			return [];
		}
	}

	private getAgent(agentId: string): PiAgent {
		const agent = this.agents.get(agentId);
		if (!agent) {
			throw new Error(`Agent "${agentId}" not found`);
		}
		return agent;
	}
}
