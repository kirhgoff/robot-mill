import { resolve } from "node:path";

export interface Config {
	hostRunnerUrl: string;
	hostRunnerWsUrl: string;
	stateDir: string;
	port: number;
	mediaProject: string;
	robotProject: string;
	eurotripProject: string;
	checkIntervalMs: number;
	eurotripCheckIntervalMs: number;
	eurotripMaxAgeMs: number;
	promptTimeoutMs: number;
}

function env(key: string, fallback = ""): string {
	return process.env[key] ?? fallback;
}

export function loadConfig(): Config {
	return {
		hostRunnerUrl: env("HOST_RUNNER_URL", "http://127.0.0.1:3200"),
		hostRunnerWsUrl: env("HOST_RUNNER_WS_URL", "ws://127.0.0.1:3200/ws"),
		stateDir: env("STATE_DIR", resolve(env("HOME"), "robot-mill/health")),
		port: Number(env("HEALTH_PORT", "3300")),
		mediaProject: env("MEDIA_PROJECT", "media-streaming"),
		robotProject: env("ROBOT_PROJECT", "robot-mill"),
		eurotripProject: env("EUROTRIP_PROJECT", "eurotrip-support"),
		checkIntervalMs: Number(env("CHECK_INTERVAL_MS", String(30 * 60 * 1000))),
		eurotripCheckIntervalMs: Number(env("EUROTRIP_CHECK_INTERVAL_MS", String(6 * 60 * 60 * 1000))),
		eurotripMaxAgeMs: Number(env("EUROTRIP_MAX_AGE_MS", String(24 * 60 * 60 * 1000))),
		promptTimeoutMs: Number(env("PROMPT_TIMEOUT_MS", String(10 * 60 * 1000))),
	};
}
