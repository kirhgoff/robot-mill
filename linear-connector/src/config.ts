export interface Config {
	linearApiKey: string;
	teamKey: string;
	triggerState: string;
	inProgressState: string;
	reviewState: string;
	doneState: string;
	failedState: string;
	agentLabel: string;
	opsLabel: string;
	hostRunnerUrl: string;
	pollIntervalMs: number;
	tickMs: number;
	taskTimeoutMs: number;
	maxConcurrentTasks: number;
	port: number;
	githubToken: string;
	telegramBotToken: string;
	telegramChatId: string;
	planModel: string;
	execModel: string;
	modelProvider: string;
}

function env(key: string, fallback = ""): string {
	return process.env[key] || fallback;
}

export function loadConfig(): Config {
	return {
		linearApiKey: env("LINEAR_API_KEY"),
		teamKey: env("LINEAR_TEAM_KEY", "KIR"),
		triggerState: env("LINEAR_TRIGGER_STATE", "Agent Queue"),
		inProgressState: env("LINEAR_IN_PROGRESS_STATE", "In Progress"),
		reviewState: env("LINEAR_REVIEW_STATE", "In Review"),
		doneState: env("LINEAR_DONE_STATE", "Done"),
		failedState: env("LINEAR_FAILED_STATE", "Agent Failed"),
		agentLabel: env("LINEAR_AGENT_LABEL", "agent"),
		opsLabel: env("LINEAR_OPS_LABEL", "ops"),
		hostRunnerUrl: env("HOST_RUNNER_URL", "http://127.0.0.1:3200"),
		pollIntervalMs: Number(env("POLL_INTERVAL_MS", "3600000")),
		tickMs: Number(env("TICK_MS", "30000")),
		taskTimeoutMs: Number(env("TASK_TIMEOUT_MS", "7200000")),
		maxConcurrentTasks: Number(env("MAX_CONCURRENT_TASKS", "3")),
		port: Number(env("LINEAR_CONNECTOR_PORT", "3400")),
		githubToken: env("GITHUB_TOKEN"),
		telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
		telegramChatId: env("TELEGRAM_CHAT_ID"),
		planModel: env("PLAN_MODEL"),
		execModel: env("EXEC_MODEL"),
		modelProvider: env("MODEL_PROVIDER"),
	};
}

export function validateConfig(config: Config): string[] {
	const errors: string[] = [];
	if (!config.linearApiKey) errors.push("LINEAR_API_KEY is required");
	if (!config.teamKey) errors.push("LINEAR_TEAM_KEY is required");
	return errors;
}
