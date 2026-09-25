import { resolve } from "node:path";

export interface Config {
	hostRunnerUrl: string;
	projectsDir: string;
	port: number;
	serviceProjects: string[];
	checkIntervalMs: number;
	checkTimeoutMs: number;
	diagnoseOnFailure: boolean;
	diagnoseTimeoutMs: number;
	providerKeyEnv: string;
	providerKey: string;
	piModel: string;
	minCreditsUsd: number;
	telegramBotToken: string;
	telegramChatId: string;
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	openai: "OPENAI_API_KEY",
};

function env(key: string, fallback = ""): string {
	return process.env[key] || fallback;
}

function resolveKey(provider: string, suffix: string): { env: string; value: string } {
	const base = PROVIDER_API_KEY_ENV[provider] ?? "OPENROUTER_API_KEY";
	const value = env(`${base}_${suffix}`) || env(base);
	return { env: base, value };
}

export function loadConfig(): Config {
	const provider = env("PI_PROVIDER", "openrouter");
	const key = resolveKey(provider, "SERVICE");
	const day = 24 * 60 * 60 * 1000;
	return {
		hostRunnerUrl: env("HOST_RUNNER_URL", "http://127.0.0.1:3200"),
		projectsDir: env("PROJECTS_DIR", resolve(env("HOME"), "Projects")),
		port: Number(env("HEALTH_PORT", "3300")),
		serviceProjects: env("SERVICE_PROJECTS", "media-streaming,robot-mill,nightcrawler")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		checkIntervalMs: Number(env("CHECK_INTERVAL_MS", String(day))),
		checkTimeoutMs: Number(env("CHECK_TIMEOUT_MS", String(2 * 60 * 1000))),
		diagnoseOnFailure: env("DIAGNOSE_ON_FAILURE", "true") !== "false",
		diagnoseTimeoutMs: Number(env("DIAGNOSE_TIMEOUT_MS", String(5 * 60 * 1000))),
		providerKeyEnv: key.env,
		providerKey: key.value,
		piModel: env("PI_MODEL"),
		minCreditsUsd: Number(env("MIN_CREDITS_USD", "10")),
		telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
		telegramChatId: env("TELEGRAM_CHAT_ID"),
	};
}
