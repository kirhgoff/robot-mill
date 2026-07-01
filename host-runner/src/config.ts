import { resolve } from "node:path";

export interface Config {
	host: string;
	port: number;
	projectsDir: string;
	stateDir: string;
	allowedProjects: string[];
	piProvider: string;
	piModel: string;
	providerKeyEnv: string;
	githubToken: string;
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	openai: "OPENAI_API_KEY",
};

function env(key: string, fallback = ""): string {
	return process.env[key] ?? fallback;
}

export function loadConfig(): Config {
	const piProvider = env("PI_PROVIDER", "openrouter");
	return {
		host: env("HOST_RUNNER_HOST", "0.0.0.0"),
		port: Number(env("HOST_RUNNER_PORT", "3200")),
		projectsDir: env("PROJECTS_DIR", resolve(env("HOME"), "Projects")),
		stateDir: env("STATE_DIR", resolve(env("HOME"), "robot-mill/host-runner")),
		allowedProjects: env("ALLOWED_PROJECTS")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		piProvider,
		piModel: env("PI_MODEL"),
		providerKeyEnv: PROVIDER_API_KEY_ENV[piProvider] ?? "OPENROUTER_API_KEY",
		githubToken: env("GITHUB_TOKEN"),
	};
}

export function validateConfig(config: Config): string[] {
	const errors: string[] = [];
	if (!process.env[config.providerKeyEnv]) {
		errors.push(`${config.providerKeyEnv} is required for PI_PROVIDER=${config.piProvider}`);
	}
	if (!config.port || config.port < 1 || config.port > 65535) {
		errors.push(`HOST_RUNNER_PORT must be 1–65535, got ${config.port}`);
	}
	return errors;
}
