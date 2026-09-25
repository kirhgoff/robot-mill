import { join } from "node:path";
import type { CheckStatus, Verdict } from "./checks";
import { providerCheck, serviceCheck } from "./checks";
import type { Config } from "./config";
import { notify } from "./telegram";

export type { CheckStatus } from "./checks";

export interface CheckResult {
	name: string;
	project: string;
	status: CheckStatus;
	detail: string;
	at: number;
	durationMs: number;
}

const PROVIDER_CHECK = "openrouter";

export class Monitor {
	private config: Config;
	private results = new Map<string, CheckResult>();
	private notifiedStatus = new Map<string, CheckStatus>();

	constructor(config: Config) {
		this.config = config;
	}

	private knownChecks(): string[] {
		return [...this.config.serviceProjects, PROVIDER_CHECK];
	}

	private seedInitial(): void {
		for (const name of this.knownChecks()) {
			if (this.results.has(name)) continue;
			this.results.set(name, {
				name,
				project: name,
				status: "unknown",
				detail: "waiting for first check…",
				at: Date.now(),
				durationMs: 0,
			});
		}
	}

	start(): void {
		this.seedInitial();
		void this.runAll();
		setInterval(() => void this.runAll(), this.config.checkIntervalMs);
	}

	private async runAll(): Promise<void> {
		await Promise.all([
			...this.config.serviceProjects.map((p) => this.runServiceCheck(p)),
			this.runProviderCheck(),
		]);
	}

	snapshot(): CheckResult[] {
		return [...this.results.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async recheck(name: string): Promise<CheckResult | null> {
		if (!this.knownChecks().includes(name)) return null;
		this.results.set(name, {
			name,
			project: name,
			status: "unknown",
			detail: "re-checking…",
			at: Date.now(),
			durationMs: 0,
		});
		if (this.config.serviceProjects.includes(name)) await this.runServiceCheck(name);
		else await this.runProviderCheck();
		return this.results.get(name) ?? null;
	}

	private record(
		name: string,
		status: CheckStatus,
		detail: string,
		startedAt: number,
		silent = false,
	): void {
		this.results.set(name, {
			name,
			project: name,
			status,
			detail: detail.slice(0, 2000),
			at: Date.now(),
			durationMs: Date.now() - startedAt,
		});
		console.log(`[${name}] ${status.toUpperCase()} — ${detail.slice(0, 160).replace(/\n/g, " ")}`);
		if (silent) return;
		const wasFailing = this.notifiedStatus.get(name) === "fail" || this.notifiedStatus.get(name) === "error";
		const failing = status === "fail" || status === "error";
		if (failing && !wasFailing) void notify(this.config, `🔴 ${name} FAIL — ${detail.slice(0, 300)}`);
		else if (status === "ok" && wasFailing) void notify(this.config, `🟢 ${name} recovered`);
		this.notifiedStatus.set(name, status);
	}

	private async runServiceCheck(project: string): Promise<void> {
		const startedAt = Date.now();
		const dir = join(this.config.projectsDir, project);
		const verdict = await serviceCheck(dir, this.config.checkTimeoutMs);
		if (verdict.status !== "fail" || !this.config.diagnoseOnFailure) {
			this.record(project, verdict.status, verdict.detail, startedAt);
			return;
		}
		this.record(project, verdict.status, `${verdict.detail} — diagnosing…`, startedAt, true);
		const fixed = await this.diagnose(project, verdict.detail);
		this.record(project, fixed.status, `was: ${verdict.detail}\nfix: ${fixed.detail}`, startedAt);
	}

	private async diagnose(project: string, failure: string): Promise<Verdict> {
		const message = [
			`A deterministic health check for "${project}" just FAILED: ${failure}`,
			"You are in the project directory on the host with full access.",
			"Investigate, attempt a SAFE fix (e.g. restart the affected service with `docker compose up -d` or `docker compose restart <service>`),",
			"then re-run the check to confirm. Do not make risky or destructive changes.",
			"Reply with a single final line: `HEALTH: OK - <what you fixed>` if resolved,",
			"or `HEALTH: FAIL - <root cause + what needs manual attention>` if not.",
		].join(" ");
		try {
			const res = await fetch(
				`${this.config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/diagnose`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ message, timeoutMs: this.config.diagnoseTimeoutMs }),
					signal: AbortSignal.timeout(this.config.diagnoseTimeoutMs + 30000),
				},
			);
			if (!res.ok) return { status: "fail", detail: `diagnosis unavailable (host-runner ${res.status})` };
			const body = (await res.json()) as { text?: string };
			return parseVerdict(body.text ?? "");
		} catch (err) {
			return { status: "error", detail: err instanceof Error ? err.message : "diagnosis failed" };
		}
	}

	private async runProviderCheck(): Promise<void> {
		const startedAt = Date.now();
		const verdict = await providerCheck(
			this.config.providerKey,
			this.config.piModel,
			this.config.minCreditsUsd,
		);
		this.record(PROVIDER_CHECK, verdict.status, verdict.detail, startedAt);
	}
}

function parseVerdict(text: string): Verdict {
	const match = text.match(/HEALTH:\s*(OK|FAIL)\b[ \t-]*(.*)/i);
	if (!match) return { status: "unknown", detail: text.trim().slice(0, 500) || "no verdict returned" };
	return {
		status: match[1].toUpperCase() === "OK" ? "ok" : "fail",
		detail: (match[2] || "").trim() || text.trim().slice(0, 500),
	};
}
