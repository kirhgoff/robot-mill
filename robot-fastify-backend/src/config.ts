/**
 * Centralised configuration.
 *
 * APP_ENV controls which defaults are used:
 *   - "production"  → Docker paths (/workspace, /data/agent-sessions)
 *   - "development" → local paths (.data/workspace, .data/sessions)
 *
 * Every value can still be overridden via its own env var.
 */

import { resolve } from "node:path";

export type AppEnv = "production" | "development";

export interface Config {
	/** "production" or "development" */
	appEnv: AppEnv;
	/** Server host */
	host: string;
	/** Server port */
	port: number;
	/** Base workspace path for agents */
	workspace: string;
	/** Directory for persisted agent sessions */
	sessionStorage: string;
	/** Default pi provider */
	piProvider: string;
	/** Default pi model */
	piModel: string;
	/** Anthropic API key forwarded to pi */
	anthropicApiKey: string;
	/** Log level */
	logLevel: string;
}

/** Root of this package (where package.json lives). */
const PROJECT_ROOT = resolve(import.meta.dirname, "..");

function env(key: string, fallback = ""): string {
	return process.env[key] ?? fallback;
}

function productionConfig(): Config {
	return {
		appEnv: "production",
		host: env("BACKEND_HOST", "0.0.0.0"),
		port: Number(env("BACKEND_PORT", "3100")),
		workspace: env("WORKSPACE", "/workspace"),
		sessionStorage: env("SESSION_STORAGE", "/data/agent-sessions"),
		piProvider: env("PI_PROVIDER", "anthropic"),
		piModel: env("PI_MODEL"),
		anthropicApiKey: env("ANTHROPIC_API_KEY"),
		logLevel: env("LOG_LEVEL", "info"),
	};
}

function developmentConfig(): Config {
	return {
		appEnv: "development",
		host: env("BACKEND_HOST", "127.0.0.1"),
		port: Number(env("BACKEND_PORT", "3100")),
		workspace: env("WORKSPACE", resolve(PROJECT_ROOT, ".data/workspace")),
		sessionStorage: env("SESSION_STORAGE", resolve(PROJECT_ROOT, ".data/sessions")),
		piProvider: env("PI_PROVIDER", "anthropic"),
		piModel: env("PI_MODEL"),
		anthropicApiKey: env("ANTHROPIC_API_KEY"),
		logLevel: env("LOG_LEVEL", "debug"),
	};
}

export function loadConfig(appEnv?: AppEnv): Config {
	const resolved: AppEnv =
		appEnv ?? (env("APP_ENV", "development") === "production" ? "production" : "development");

	return resolved === "production" ? productionConfig() : developmentConfig();
}

// ── Validation ───────────────────────────────────

export interface ConfigError {
	field: string;
	message: string;
}

/**
 * Validate a config object. Returns an array of errors (empty = valid).
 * Call this at startup and fail fast if critical values are missing.
 */
export function validateConfig(config: Config): ConfigError[] {
	const errors: ConfigError[] = [];

	if (!config.anthropicApiKey) {
		errors.push({ field: "anthropicApiKey", message: "ANTHROPIC_API_KEY is required" });
	}

	if (!config.workspace) {
		errors.push({ field: "workspace", message: "WORKSPACE must not be empty" });
	}

	if (!config.sessionStorage) {
		errors.push({ field: "sessionStorage", message: "SESSION_STORAGE must not be empty" });
	}

	if (!config.port || config.port < 1 || config.port > 65535) {
		errors.push({ field: "port", message: `BACKEND_PORT must be 1–65535, got ${config.port}` });
	}

	if (!config.piProvider) {
		errors.push({ field: "piProvider", message: "PI_PROVIDER must not be empty" });
	}

	return errors;
}
