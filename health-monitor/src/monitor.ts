import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

export type CheckStatus = "ok" | "fail" | "error" | "unknown";

export interface CheckResult {
	name: string;
	project: string;
	status: CheckStatus;
	detail: string;
	at: number;
	durationMs: number;
}

interface Pending {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class Monitor {
	private config: Config;
	private ws: WebSocket | null = null;
	private pending = new Map<string, Pending>();
	private gen = new Map<string, number>();
	private results = new Map<string, CheckResult>();

	constructor(config: Config) {
		this.config = config;
		mkdirSync(config.stateDir, { recursive: true });
	}

	private seedInitial(): void {
		for (const project of [this.config.mediaProject, this.config.robotProject, this.config.eurotripProject]) {
			if (this.results.has(project)) continue;
			this.results.set(project, {
				name: project,
				project,
				status: "unknown",
				detail: "waiting for first check…",
				at: Date.now(),
				durationMs: 0,
			});
		}
	}

	start(): void {
		this.seedInitial();
		this.connect();
		void this.runHealthCheck(this.config.mediaProject, mediaPrompt());
		void this.runHealthCheck(this.config.robotProject, robotPrompt());
		void this.runEurotripCheck();

		setInterval(() => {
			void this.runHealthCheck(this.config.mediaProject, mediaPrompt());
			void this.runHealthCheck(this.config.robotProject, robotPrompt());
		}, this.config.checkIntervalMs);
		setInterval(() => void this.runEurotripCheck(), this.config.eurotripCheckIntervalMs);
	}

	snapshot(): CheckResult[] {
		return [...this.results.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async recheck(project: string): Promise<CheckResult | null> {
		const known = [this.config.mediaProject, this.config.robotProject, this.config.eurotripProject];
		if (!known.includes(project)) return null;
		this.results.set(project, {
			name: project,
			project,
			status: "unknown",
			detail: "re-checking…",
			at: Date.now(),
			durationMs: 0,
		});
		if (project === this.config.mediaProject) {
			await this.runHealthCheck(project, mediaPrompt());
		} else if (project === this.config.robotProject) {
			await this.runHealthCheck(project, robotPrompt());
		} else {
			await this.runEurotripCheck();
		}
		return this.results.get(project) ?? null;
	}

	private connect(): void {
		this.ws = new WebSocket(this.config.hostRunnerWsUrl);
		this.ws.onopen = () => console.log(`connected to host-runner ${this.config.hostRunnerWsUrl}`);
		this.ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(ev.data as string);
				if (msg.type === "message_complete" && typeof msg.project === "string") {
					const p = this.pending.get(msg.project);
					if (p) {
						clearTimeout(p.timer);
						this.pending.delete(msg.project);
						p.resolve(String(msg.data ?? ""));
					}
				}
			} catch {
				// ignore
			}
		};
		this.ws.onclose = () => {
			console.warn("host-runner WS closed; reconnecting in 3s");
			setTimeout(() => this.connect(), 3000);
		};
		this.ws.onerror = () => this.ws?.close();
	}

	private async prompt(project: string, message: string): Promise<string> {
		const existing = this.pending.get(project);
		if (existing) {
			clearTimeout(existing.timer);
			this.pending.delete(project);
			existing.reject(new Error("superseded by a newer check"));
		}
		const completion = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(project);
				reject(new Error("timed out waiting for agent"));
			}, this.config.promptTimeoutMs);
			this.pending.set(project, { resolve, reject, timer });
		});
		const res = await fetch(`${this.config.hostRunnerUrl}/projects/${encodeURIComponent(project)}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message }),
		});
		if (!res.ok) {
			const p = this.pending.get(project);
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(project);
			}
			throw new Error(`host-runner prompt failed (${res.status})`);
		}
		return completion;
	}

	private record(name: string, project: string, status: CheckStatus, detail: string, startedAt: number): void {
		this.results.set(name, {
			name,
			project,
			status,
			detail: detail.slice(0, 2000),
			at: Date.now(),
			durationMs: Date.now() - startedAt,
		});
		console.log(`[${name}] ${status.toUpperCase()} — ${detail.slice(0, 160).replace(/\n/g, " ")}`);
	}

	private async runHealthCheck(project: string, prompt: string): Promise<void> {
		const startedAt = Date.now();
		const myGen = (this.gen.get(project) ?? 0) + 1;
		this.gen.set(project, myGen);
		try {
			const text = await this.prompt(project, prompt);
			if (this.gen.get(project) !== myGen) return;
			const verdict = parseVerdict(text);
			this.record(project, project, verdict.status, verdict.detail, startedAt);
		} catch (err) {
			if (this.gen.get(project) !== myGen) return;
			this.record(project, project, "error", err instanceof Error ? err.message : "unknown", startedAt);
		}
	}

	private async runEurotripCheck(): Promise<void> {
		const project = this.config.eurotripProject;
		const startedAt = Date.now();
		const myGen = (this.gen.get(project) ?? 0) + 1;
		this.gen.set(project, myGen);
		const marker = join(this.config.stateDir, "eurotrip-last-sync");
		const lastSync = readTimestamp(marker);
		const ageMs = lastSync ? Date.now() - lastSync : Number.POSITIVE_INFINITY;

		if (ageMs <= this.config.eurotripMaxAgeMs) {
			const hours = Math.round(ageMs / 3_600_000);
			this.record(project, project, "ok", `last sync ${hours}h ago (fresh)`, startedAt);
			return;
		}

		try {
			const text = await this.prompt(project, eurotripSyncPrompt());
			if (this.gen.get(project) !== myGen) return;
			const verdict = parseVerdict(text);
			if (verdict.status === "ok") {
				writeFileSync(marker, String(Date.now()));
				this.record(project, project, "ok", `stale — ran full sync: ${verdict.detail}`, startedAt);
			} else {
				this.record(project, project, "fail", `sync failed: ${verdict.detail}`, startedAt);
			}
		} catch (err) {
			if (this.gen.get(project) !== myGen) return;
			this.record(project, project, "error", err instanceof Error ? err.message : "unknown", startedAt);
		}
	}
}

function parseVerdict(text: string): { status: CheckStatus; detail: string } {
	const match = text.match(/HEALTH:\s*(OK|FAIL)\b[ \t-]*(.*)/i);
	if (!match) return { status: "unknown", detail: text.trim().slice(0, 500) };
	return {
		status: match[1].toUpperCase() === "OK" ? "ok" : "fail",
		detail: (match[2] || "").trim() || text.trim().slice(0, 500),
	};
}

function readTimestamp(path: string): number | null {
	try {
		if (!existsSync(path)) return null;
		const value = Number(readFileSync(path, "utf-8").trim());
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function mediaPrompt(): string {
	return [
		"Health check for the media stack. If this project has a health-check skill, use it.",
		"Otherwise run `docker compose ps` and verify every service is Up (and healthy where a healthcheck exists).",
		"Reply with a single final line: `HEALTH: OK` if all good, or `HEALTH: FAIL - <which services and why>`.",
	].join(" ");
}

function robotPrompt(): string {
	return [
		"Health check for robot-mill. Run `docker compose ps` and `curl -fsS http://127.0.0.1:3100/health_check`.",
		"Reply with a single final line: `HEALTH: OK` if the backend returns ok and containers are Up,",
		"or `HEALTH: FAIL - <reason>`.",
	].join(" ");
}

function eurotripSyncPrompt(): string {
	return [
		"The eurotrip-support data is stale (>24h since last sync). Run the full sync now: `bun run all`.",
		"Wait for it to finish. Reply with a single final line: `HEALTH: OK - <one-line summary>` if it completed,",
		"or `HEALTH: FAIL - <error>` if it failed.",
	].join(" ");
}
