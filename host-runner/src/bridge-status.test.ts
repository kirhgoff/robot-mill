import { expect, test } from "bun:test";
import { applyPiEvent, initialBridgeState, piArgs } from "./bridge-status";

const rateLimited = {
	type: "message_end",
	message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" },
};

test("retrying agent_end keeps the task busy", () => {
	const state = initialBridgeState();
	applyPiEvent(state, { type: "agent_start" });
	applyPiEvent(state, rateLimited);
	expect(applyPiEvent(state, { type: "agent_end", willRetry: true })).toBe(false);
	expect(state.status.busy).toBe(true);
	expect(state.status.endedAt).toBeNull();
});

test("exhausted retries end with the error", () => {
	const state = initialBridgeState();
	for (const willRetry of [true, false]) {
		applyPiEvent(state, { type: "agent_start" });
		applyPiEvent(state, rateLimited);
		applyPiEvent(state, { type: "agent_end", willRetry });
	}
	expect(state.status.busy).toBe(false);
	expect(state.status.endedAt).not.toBeNull();
	expect(state.status.error).toBe("429 rate limit");
});

test("successful run has no error", () => {
	const state = initialBridgeState();
	applyPiEvent(state, { type: "agent_start" });
	applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
	applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
	applyPiEvent(state, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	expect(applyPiEvent(state, { type: "agent_end", willRetry: false })).toBe(true);
	expect(state.status).toMatchObject({ busy: false, lastText: "hello world", error: null });
});

test("piArgs passes provider only together with model", () => {
	expect(piArgs("s", "openai", undefined, false)).toEqual(["--mode", "rpc", "--session", "s"]);
	expect(piArgs("s", "openai", "gpt-6-luna", true)).toEqual([
		"--mode", "rpc", "--session", "s", "--provider", "openai", "--model", "gpt-6-luna", "-c",
	]);
});

test("rate limit errors are recorded and survive the next agent_start", () => {
	const state = initialBridgeState();
	applyPiEvent(state, { type: "agent_start" });
	expect(applyPiEvent(state, rateLimited)).toBe(true);
	expect(state.status.rateLimitError).toBe("429 rate limit");
	expect(state.status.rateLimitedAt).not.toBeNull();
	applyPiEvent(state, { type: "agent_start" });
	expect(state.status.rateLimitError).toBe("429 rate limit");
	expect(state.status.rateLimitedAt).not.toBeNull();
});

test("other errors do not set rateLimitError", () => {
	const state = initialBridgeState();
	applyPiEvent(state, { type: "agent_start" });
	applyPiEvent(state, {
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "401: bad key" },
	});
	expect(state.status.rateLimitError).toBeNull();
});
