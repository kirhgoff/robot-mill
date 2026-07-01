export interface Config {
	linearApiKey: string;
	teamKey: string;
	triggerState: string;
	inProgressState: string;
	reviewState: string;
	hostRunnerUrl: string;
	hostRunnerWsUrl: string;
	pollIntervalMs: number;
	promptTimeoutMs: number;
}

function env(key: string, fallback = ""): string {
	return process.env[key] ?? fallback;
}

export function loadConfig(): Config {
	return {
		linearApiKey: env("LINEAR_API_KEY"),
		teamKey: env("LINEAR_TEAM_KEY", "KIR"),
		triggerState: env("LINEAR_TRIGGER_STATE", "Agent Queue"),
		inProgressState: env("LINEAR_IN_PROGRESS_STATE", "In Progress"),
		reviewState: env("LINEAR_REVIEW_STATE", "In Review"),
		hostRunnerUrl: env("HOST_RUNNER_URL", "http://127.0.0.1:3200"),
		hostRunnerWsUrl: env("HOST_RUNNER_WS_URL", "ws://127.0.0.1:3200/ws"),
		pollIntervalMs: Number(env("POLL_INTERVAL_MS", "15000")),
		promptTimeoutMs: Number(env("PROMPT_TIMEOUT_MS", "600000")),
	};
}

export function validateConfig(config: Config): string[] {
	const errors: string[] = [];
	if (!config.linearApiKey) errors.push("LINEAR_API_KEY is required");
	if (!config.teamKey) errors.push("LINEAR_TEAM_KEY is required");
	return errors;
}
