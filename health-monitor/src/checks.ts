import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CheckStatus = "ok" | "fail" | "error" | "unknown";

export interface Verdict {
	status: CheckStatus;
	detail: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): { code: number; out: string } {
	const res = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: timeoutMs });
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
	if (res.error) return { code: 1, out: res.error.message };
	return { code: res.status ?? 1, out };
}

function lastLine(text: string): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

export function serviceCheck(projectDir: string, timeoutMs: number): Verdict {
	if (!existsSync(projectDir)) {
		return { status: "error", detail: `project dir not found: ${projectDir}` };
	}
	const script = join(projectDir, "scripts", "health-check.sh");
	if (existsSync(script)) {
		const res = run("bash", [script], projectDir, timeoutMs);
		const detail = lastLine(res.out) || (res.code === 0 ? "ok" : "check failed");
		return { status: res.code === 0 ? "ok" : "fail", detail };
	}
	return dockerComposeCheck(projectDir, timeoutMs);
}

interface ComposeService {
	Name?: string;
	Service?: string;
	State?: string;
	Health?: string;
}

function parseCompose(out: string): ComposeService[] {
	const trimmed = out.trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as ComposeService;
				} catch {
					return null;
				}
			})
			.filter((s): s is ComposeService => s !== null);
	}
}

export function dockerComposeCheck(projectDir: string, timeoutMs: number): Verdict {
	const res = run("docker", ["compose", "ps", "--format", "json"], projectDir, timeoutMs);
	if (res.code !== 0) {
		return { status: "fail", detail: `docker compose ps failed: ${lastLine(res.out)}` };
	}
	const services = parseCompose(res.out);
	if (services.length === 0) {
		return { status: "fail", detail: "no services running" };
	}
	const unhealthy = services.filter(
		(s) => s.State !== "running" || (s.Health && s.Health !== "healthy"),
	);
	if (unhealthy.length > 0) {
		const detail = unhealthy
			.map((s) => `${s.Service ?? s.Name}=${s.State}${s.Health ? `/${s.Health}` : ""}`)
			.join(", ");
		return { status: "fail", detail: `${unhealthy.length}/${services.length} not healthy: ${detail}` };
	}
	return { status: "ok", detail: `${services.length}/${services.length} services running` };
}

export function runSync(projectDir: string, timeoutMs: number): Verdict {
	const res = run("bun", ["run", "all"], projectDir, timeoutMs);
	return {
		status: res.code === 0 ? "ok" : "fail",
		detail: lastLine(res.out) || (res.code === 0 ? "sync completed" : "sync failed"),
	};
}

export interface ProviderVerdict extends Verdict {
	remaining?: number;
	total?: number;
	usage?: number;
}

export async function providerCheck(
	key: string,
	model: string,
	minCreditsUsd: number,
): Promise<ProviderVerdict> {
	if (!key) return { status: "unknown", detail: "no provider key configured" };
	try {
		const creditsRes = await fetch("https://openrouter.ai/api/v1/credits", {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10000),
		});
		if (!creditsRes.ok) {
			return { status: "fail", detail: `credits endpoint returned ${creditsRes.status}` };
		}
		const body = (await creditsRes.json()) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		const total = Number(body.data?.total_credits ?? 0);
		const usage = Number(body.data?.total_usage ?? 0);
		const remaining = total - usage;

		const modelNote = await modelAvailability(key, model);
		const balance = `$${remaining.toFixed(2)} left ($${usage.toFixed(2)}/$${total.toFixed(2)} used)`;

		if (remaining < minCreditsUsd) {
			return {
				status: "fail",
				detail: `LOW BALANCE: ${balance} (below $${minCreditsUsd}). ${modelNote}`,
				remaining,
				total,
				usage,
			};
		}
		return { status: "ok", detail: `${balance}. ${modelNote}`, remaining, total, usage };
	} catch (err) {
		return { status: "error", detail: err instanceof Error ? err.message : "provider check failed" };
	}
}

async function modelAvailability(key: string, model: string): Promise<string> {
	if (!model) return "no PI_MODEL set";
	try {
		const res = await fetch("https://openrouter.ai/api/v1/models", {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return `model list unavailable (${res.status})`;
		const body = (await res.json()) as { data?: { id?: string }[] };
		const available = (body.data ?? []).some((m) => m.id === model);
		return available ? `model ${model} available` : `⚠ model ${model} NOT in provider catalog`;
	} catch {
		return "model list unreachable";
	}
}
