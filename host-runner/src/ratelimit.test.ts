import { expect, test } from "bun:test";
import { parseRateLimitHeaders, rateLimits } from "./ratelimit";

test("parses request and token headers", () => {
	const h = new Headers({
		"x-ratelimit-limit-requests": "5000",
		"x-ratelimit-remaining-requests": "4999",
		"x-ratelimit-limit-tokens": "2000000",
		"x-ratelimit-remaining-tokens": "1999000",
	});
	expect(parseRateLimitHeaders(h)).toEqual({
		requests: { limit: 5000, remaining: 4999 },
		tokens: { limit: 2000000, remaining: 1999000 },
	});
});

test("missing token headers give null tokens", () => {
	const h = new Headers({ "x-ratelimit-limit-requests": "5000", "x-ratelimit-remaining-requests": "10" });
	expect(parseRateLimitHeaders(h).tokens).toBeNull();
});

test("non-openai providers are unknown without a request", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error("fetch must not be called");
	}) as unknown as typeof fetch;
	try {
		expect(await rateLimits("openrouter", "m", "k")).toEqual({
			provider: "openrouter",
			model: "m",
			requests: null,
			tokens: null,
		});
	} finally {
		globalThis.fetch = realFetch;
	}
});
