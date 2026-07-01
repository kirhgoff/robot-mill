/**
 * Core agent types — independent of any specific agent runtime (pi, etc.)
 */

export type AgentStatus = "idle" | "running" | "error" | "stopped";

export interface AgentInfo {
	/** Unique agent ID */
	id: string;
	/** Human-readable name */
	name: string;
	/** Agent runtime type */
	runtime: "pi" | "custom";
	/** Current status */
	status: AgentStatus;
	/** Working directory */
	cwd: string;
	/** What the agent is currently doing */
	currentTask: string;
	/** When the agent was created */
	createdAt: number;
	/** When the agent last received a prompt */
	lastActivityAt: number;
	/** Whether the agent has a persisted session */
	hasSession: boolean;
	/** Extra metadata */
	meta: Record<string, unknown>;
}

export interface AgentOutput {
	type:
		| "text"
		| "tool_start"
		| "tool_end"
		| "error"
		| "status_change"
		| "raw_event";
	agentId: string;
	timestamp: number;
	data: unknown;
}

export interface PromptRequest {
	agentId: string;
	message: string;
}

export interface SpawnAgentRequest {
	name: string;
	cwd?: string;
	provider?: string;
	model?: string;
	tools?: string;
	systemPrompt?: string;
	sessionId?: string;
	/** Resume an existing session file */
	resumeSession?: boolean;
}

export interface AgentCommand {
	type: "prompt" | "abort" | "new_session" | "kill" | "status";
	agentId: string;
	payload?: unknown;
}

export interface SystemStatus {
	uptime: number;
	agentCount: number;
	agents: AgentInfo[];
	sessionStoragePath: string;
}
