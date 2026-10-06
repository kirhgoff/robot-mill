import { expect, test } from "bun:test";
import { formatLimits, nearLimit, type RateLimits, runInfoComment } from "./ratelimit";

const limits = (tokensLeft: number, requestsLeft = 5000): RateLimits => ({
	provider: "openai",
	model: "m",
	requests: { limit: 5000, remaining: requestsLeft },
	tokens: { limit: 2_000_000, remaining: tokensLeft },
});

test("nearLimit flags 80% usage of tokens or requests", () => {
	expect(nearLimit(limits(400_000))).toBe(true);
	expect(nearLimit(limits(401_000))).toBe(false);
	expect(nearLimit(limits(2_000_000, 1000))).toBe(true);
	expect(nearLimit({ provider: "x", model: "m", requests: null, tokens: null })).toBe(false);
});

test("formatLimits", () => {
	expect(formatLimits(null)).toBe("unknown");
	const text = formatLimits(limits(1_000_000));
	expect(text).toContain("5,000 RPM");
	expect(text).toContain("2,000,000 TPM");
});

test("runInfoComment", () => {
	const base = {
		phase: "plan" as const,
		project: "p",
		key: "p-kir-1",
		name: "kir-1",
		dir: "/w",
		provider: "openai",
		model: "m",
		piVersion: "1.0",
		limits: null,
	};
	const code = runInfoComment({ ...base, mode: "code" });
	expect(code).toContain("tmux attach -t pi-p-kir-1");
	expect(code).toContain("branch `kir-1`");
	expect(runInfoComment({ ...base, mode: "ops" })).not.toContain("branch");
});
