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
	providerKey: string;
	taskKey: string;
	serviceProvider: string;
	serviceModel: string;
	serviceKeyEnv: string;
	serviceKey: string;
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

function keyEnvFor(provider: string): string {
	return PROVIDER_API_KEY_ENV[provider] ?? "OPENROUTER_API_KEY";
}

function resolveKey(provider: string, suffix: string): { env: string; value: string } {
	const base = keyEnvFor(provider);
	const value = process.env[`${base}_${suffix}`] ?? process.env[base] ?? "";
	return { env: base, value };
}

export function loadConfig(): Config {
	const piProvider = env("PI_PROVIDER", "openrouter");
	const serviceProvider = env("SERVICE_PI_PROVIDER", piProvider);
	const providerKey = resolveKey(piProvider, "HOSTRUNNER");
	const taskKey = resolveKey(piProvider, "LINEAR");
	const serviceKey = resolveKey(serviceProvider, "SERVICE");
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
		providerKeyEnv: providerKey.env,
		providerKey: providerKey.value,
		taskKey: taskKey.value,
		serviceProvider,
		serviceModel: env("SERVICE_PI_MODEL", "anthropic/claude-haiku-4.5"),
		serviceKeyEnv: serviceKey.env,
		serviceKey: serviceKey.value,
		githubToken: env("GITHUB_TOKEN"),
	};
}

export function validateConfig(config: Config): string[] {
	const errors: string[] = [];
	if (!config.providerKey) {
		errors.push(
			`${config.providerKeyEnv} (or ${config.providerKeyEnv}_HOSTRUNNER) is required for PI_PROVIDER=${config.piProvider}`,
		);
	}
	if (!config.port || config.port < 1 || config.port > 65535) {
		errors.push(`HOST_RUNNER_PORT must be 1–65535, got ${config.port}`);
	}
	return errors;
}
