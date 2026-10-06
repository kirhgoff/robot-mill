export interface Limit {
	limit: number;
	remaining: number;
}
export interface RateLimits {
	provider: string;
	model: string;
	requests: Limit | null;
	tokens: Limit | null;
}

function limit(h: Headers, kind: "requests" | "tokens"): Limit | null {
	const l = h.get(`x-ratelimit-limit-${kind}`);
	const r = h.get(`x-ratelimit-remaining-${kind}`);
	if (l === null || r === null || !Number.isFinite(Number(l)) || !Number.isFinite(Number(r))) return null;
	return { limit: Number(l), remaining: Number(r) };
}

export function parseRateLimitHeaders(h: Headers) {
	return { requests: limit(h, "requests"), tokens: limit(h, "tokens") };
}

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; data: RateLimits }>();

export async function rateLimits(provider: string, model: string, key: string): Promise<RateLimits> {
	const unknown = { provider, model, requests: null, tokens: null };
	if (provider !== "openai" || !model || !key) return unknown;
	const cacheKey = `${model}\n${key}`;
	const hit = cache.get(cacheKey);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "." }], max_completion_tokens: 1 }),
		signal: AbortSignal.timeout(5000),
	}).catch(() => null);
	await res?.body?.cancel();
	const data = res ? { provider, model, ...parseRateLimitHeaders(res.headers) } : unknown;
	cache.set(cacheKey, { at: Date.now(), data });
	return data;
}
