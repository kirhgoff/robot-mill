import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckStatus = "ok" | "fail" | "error" | "unknown";

export interface Verdict {
	status: CheckStatus;
	detail: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		const failure = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return {
			code: failure.code ?? 1,
			stdout: (failure.stdout ?? "").trim(),
			stderr: (failure.stderr ?? failure.message ?? "").trim(),
		};
	}
}

function lastLine(text: string): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

function detailFrom(res: RunResult): string {
	return lastLine(res.stdout) || lastLine(res.stderr);
}

export async function serviceCheck(projectDir: string, timeoutMs: number): Promise<Verdict> {
	if (!existsSync(projectDir)) {
		return { status: "error", detail: `project dir not found: ${projectDir}` };
	}
	const script = join(projectDir, "scripts", "health-check.sh");
	if (existsSync(script)) {
		const res = await run("bash", [script], projectDir, timeoutMs);
		const detail = detailFrom(res) || (res.code === 0 ? "ok" : "check failed");
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

export async function dockerComposeCheck(projectDir: string, timeoutMs: number): Promise<Verdict> {
	const res = await run("docker", ["compose", "ps", "--format", "json"], projectDir, timeoutMs);
	if (res.code !== 0) {
		return { status: "fail", detail: `docker compose ps failed: ${detailFrom(res)}` };
	}
	const services = parseCompose(res.stdout);
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

export interface ProviderVerdict extends Verdict {
	remaining?: number;
	total?: number;
	usage?: number;
}

export async function providerCheck(
	provider: string,
	key: string,
	piModel: string,
	planModel: string,
	execModel: string,
	minCreditsUsd: number,
): Promise<ProviderVerdict> {
	if (!key) return { status: "unknown", detail: `no ${provider} provider key configured` };
	if (provider === "openai") return openAiProviderCheck(key, planModel, execModel);
	if (provider === "openrouter") return openRouterProviderCheck(key, piModel, minCreditsUsd);
	return { status: "unknown", detail: `provider check not supported for ${provider}` };
}

async function openAiProviderCheck(
	key: string,
	planModel: string,
	execModel: string,
): Promise<ProviderVerdict> {
	const models = [...new Set([planModel, execModel].filter(Boolean))];
	if (!planModel || !execModel) {
		const missing = [!planModel && "PLAN_MODEL", !execModel && "EXEC_MODEL"].filter(Boolean);
		return { status: "unknown", detail: `missing ${missing.join(" and ")}` };
	}
	try {
		const headers = { authorization: `Bearer ${key}` };
		const keyRes = await fetch("https://api.openai.com/v1/models", {
			headers,
			signal: AbortSignal.timeout(10000),
		});
		if (!keyRes.ok) return { status: "fail", detail: `OpenAI key check returned ${keyRes.status}` };

		const checks = await Promise.all(models.map(async (model) => {
			const res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
				headers,
				signal: AbortSignal.timeout(10000),
			});
			return { model, status: res.status };
		}));
		const missing = checks.filter((check) => check.status === 404).map((check) => check.model);
		const failures = checks.filter((check) => check.status !== 200 && check.status !== 404);
		if (failures.length) {
			return {
				status: "fail",
				detail: failures.map(({ model, status }) => `${model} check returned ${status}`).join("; "),
			};
		}
		if (missing.length) return { status: "fail", detail: `OpenAI model(s) not found: ${missing.join(", ")}` };
		return { status: "ok", detail: `OpenAI key valid; models available: ${models.join(", ")}` };
	} catch (err) {
		return { status: "error", detail: err instanceof Error ? err.message : "OpenAI check failed" };
	}
}

async function openRouterProviderCheck(
	key: string,
	model: string,
	minCreditsUsd: number,
): Promise<ProviderVerdict> {
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
		const modelNote = await openRouterModelAvailability(key, model);
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

async function openRouterModelAvailability(key: string, model: string): Promise<string> {
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
