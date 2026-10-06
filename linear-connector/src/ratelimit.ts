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

export const WARN_INTERVAL_MS = 5 * 60_000;
const NEAR = 0.8;
const used = (l: Limit) => (l.limit > 0 ? 1 - l.remaining / l.limit : 0);
const n = (x: number) => x.toLocaleString("en-US");
const pct = (l: Limit) => `${Math.round(used(l) * 100)}%`;

export function nearLimit(r: RateLimits): boolean {
	return [r.requests, r.tokens].some((l) => l !== null && used(l) >= NEAR);
}

export function formatLimits(r: RateLimits | null): string {
	if (!r || (!r.requests && !r.tokens)) return `unknown${r ? ` for ${r.provider}` : ""}`;
	return [
		r.requests && `${n(r.requests.limit)} RPM (${n(r.requests.remaining)} left)`,
		r.tokens && `${n(r.tokens.limit)} TPM (${n(r.tokens.remaining)} left)`,
	]
		.filter(Boolean)
		.join(" · ");
}

export interface RunInfo {
	phase: "plan" | "execute";
	project: string;
	mode: "code" | "ops";
	key: string;
	name: string;
	dir: string;
	provider: string;
	model: string;
	piVersion: string;
	limits: RateLimits | null;
}

export function runInfoComment(i: RunInfo): string {
	return [
		`🤖 ${i.phase === "plan" ? "plan" : "build"} phase started in \`${i.project}\` (${i.mode})`,
		`- provider / model: ${i.provider} / ${i.model || "default"}`,
		`- session: \`tmux attach -t pi-${i.key}\``,
		i.mode === "code" ? `- worktree: \`${i.dir}\` on branch \`${i.name}\`` : `- checkout: \`${i.dir}\``,
		`- pi: ${i.piVersion}`,
		`- rate limits: ${formatLimits(i.limits)}`,
	].join("\n");
}

export function nearLimitComment(r: RateLimits): string {
	const parts = [r.requests && `requests ${pct(r.requests)} used`, r.tokens && `tokens ${pct(r.tokens)} used`]
		.filter(Boolean)
		.join(", ");
	return `⚠️ Approaching ${r.provider} rate limit for ${r.model}: ${parts} (${formatLimits(r)}). Budget is shared by all running agents.`;
}

export function rateLimitComment(error: string): string {
	return `⚠️ Agent hit a rate limit (pi retries automatically):\n\n${error}`;
}
