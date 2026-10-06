export interface BridgeStatus {
	busy: boolean;
	startedAt: number | null;
	endedAt: number | null;
	lastText: string | null;
	error: string | null;
	rateLimitError: string | null;
	rateLimitedAt: number | null;
}

export interface BridgeState {
	status: BridgeStatus;
	pendingText: string;
	pendingError: string | null;
}

export function initialBridgeState(): BridgeState {
	return {
		status: { busy: false, startedAt: null, endedAt: null, lastText: null, error: null, rateLimitError: null, rateLimitedAt: null },
		pendingText: "",
		pendingError: null,
	};
}

export function applyPiEvent(state: BridgeState, event: any): boolean {
	const { status } = state;
	if (event.type === "agent_start") {
		status.busy = true;
		status.startedAt = Date.now();
		status.endedAt = null;
		status.lastText = null;
		status.error = null;
		state.pendingText = "";
		state.pendingError = null;
		return true;
	}
	if (event.type === "message_update") {
		const mev = event.assistantMessageEvent;
		if (mev?.type === "text_delta") state.pendingText += mev.delta;
		return false;
	}
	if (event.type === "message_end") {
		const message = event.message;
		if (message?.role !== "assistant") return false;
		if (message.stopReason !== "error") {
			state.pendingError = null;
			return false;
		}
		const errorMessage =
			typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : "unknown error";
		state.pendingText = `agent error: ${errorMessage}`;
		state.pendingError = errorMessage;
		if (!/rate.?limit|429|too many requests/i.test(errorMessage)) return false;
		status.rateLimitError = errorMessage;
		status.rateLimitedAt = Date.now();
		return true;
	}
	if (event.type === "agent_end") {
		if (event.willRetry === true) return false;
		status.busy = false;
		status.endedAt = Date.now();
		status.lastText = state.pendingText.trim();
		status.error = state.pendingError;
		state.pendingText = "";
		state.pendingError = null;
		return true;
	}
	return false;
}

export function piArgs(session: string, provider: string, model: string | undefined, resume: boolean): string[] {
	const args = ["--mode", "rpc", "--session", session];
	if (model) args.push("--provider", provider, "--model", model);
	if (resume) args.push("-c");
	return args;
}
