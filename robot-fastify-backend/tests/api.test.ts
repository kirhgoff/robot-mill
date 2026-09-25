/**
 * Integration tests for the backend REST API.
 *
 * These spin up the Fastify server in-process (no child process needed)
 * and exercise the endpoints using Fastify's inject() helper —
 * no real HTTP port is opened.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { AgentManager } from "../src/subsystems/agent-manager/index.js";
import { registerRequestProcessor } from "../src/subsystems/request-processor/index.js";
import type { Config } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let app: FastifyInstance;
let agentManager: AgentManager;
let tempDir: string;

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "robot-backend-test-"));

	const config: Config = {
		appEnv: "development",
		host: "127.0.0.1",
		port: 0, // not used — we use inject()
		workspace: join(tempDir, "workspace"),
		sessionStorage: join(tempDir, "sessions"),
		piProvider: "anthropic",
		piModel: "",
		apiKeys: { ANTHROPIC_API_KEY: "test-key" },
		hostRunnerUrl: "http://127.0.0.1:39201",
		healthUrl: "http://127.0.0.1:39202",
		linearUrl: "http://127.0.0.1:39203",
		consoleDir: join(tempDir, "console"),
		logLevel: "silent",
		variationsEnabled: false,
	};

	app = Fastify({ logger: false });
	await app.register(websocket);

	agentManager = new AgentManager(config);
	registerRequestProcessor(app, agentManager, null, config);

	await app.ready();
});

afterAll(async () => {
	agentManager.killAll();
	await app.close();
	try {
		rmSync(tempDir, { recursive: true });
	} catch {
		// ignore
	}
});

// ── Health check ─────────────────────────────────

describe("GET /health_check", () => {
	test("returns ok", async () => {
		const res = await app.inject({ method: "GET", url: "/health_check" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "ok" });
	});
});

// ── Status ───────────────────────────────────────

describe("GET /status", () => {
	test("returns system status with zero agents", async () => {
		const res = await app.inject({ method: "GET", url: "/status" });
		expect(res.statusCode).toBe(200);

		const body = res.json();
		expect(body.agentCount).toBe(0);
		expect(body.agents).toEqual([]);
		expect(typeof body.uptime).toBe("number");
		expect(body.sessionStoragePath).toContain("sessions");
	});
});

// ── Agent CRUD ───────────────────────────────────

describe("GET /agents", () => {
	test("returns empty array when no agents running", async () => {
		const res = await app.inject({ method: "GET", url: "/agents" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual([]);
	});
});

describe("POST /agents", () => {
	test("rejects request without name", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/agents",
			payload: {},
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain("name");
	});

	test("rejects duplicate sessionId", () => {
		const payload = { name: "test-dup", sessionId: "dup-check" };
		agentManager.spawn(payload);
		expect(() => agentManager.spawn(payload)).toThrow(/already exists/);
		agentManager.kill("dup-check");
	});
});

describe("GET /agents/:id", () => {
	test("returns 404 for unknown agent", async () => {
		const res = await app.inject({ method: "GET", url: "/agents/no-such-id" });
		expect(res.statusCode).toBe(404);
	});
});

describe("POST /agents/:id/prompt", () => {
	test("returns 404 for unknown agent", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/agents/no-such-id/prompt",
			payload: { message: "hello" },
		});
		expect(res.statusCode).toBe(404);
	});

	test("rejects missing message", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/agents/no-such-id/prompt",
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("DELETE /agents/:id", () => {
	test("returns ok even for unknown agent (idempotent)", async () => {
		const res = await app.inject({
			method: "DELETE",
			url: "/agents/no-such-id",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});
});

describe("GET /agents/sessions", () => {
	test("returns array of saved session ids", async () => {
		const res = await app.inject({ method: "GET", url: "/agents/sessions" });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json())).toBe(true);
	});
});

// ── Console overview ─────────────────────────────

describe("GET /api/overview", () => {
	test("reports unreachable dependencies with no data", async () => {
		const res = await app.inject({ method: "GET", url: "/api/overview" });
		expect(res.statusCode).toBe(200);

		const body = res.json();
		expect(body.health.overall).toBe("unreachable");
		expect(body.tasks).toEqual([]);
	});
});
