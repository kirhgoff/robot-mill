/**
 * REST routes for agent CRUD and control.
 *
 * POST   /agents          — spawn a new agent
 * GET    /agents          — list all running agents
 * GET    /agents/:id      — get a single agent's info
 * POST   /agents/:id/prompt   — send a prompt
 * POST   /agents/:id/abort    — abort current operation
 * POST   /agents/:id/new-session — fresh conversation
 * DELETE /agents/:id      — kill an agent
 * GET    /agents/sessions — list saved session files
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../../agent-manager/index";

export function registerAgentRoutes(
	app: FastifyInstance,
	agentManager: AgentManager,
) {
	// ── Spawn ──────────────────────────────────────

	app.post("/agents", async (req, reply) => {
		const body = req.body as Record<string, unknown>;

		if (!body.name || typeof body.name !== "string") {
			return reply.status(400).send({ error: "name is required" });
		}

		try {
			const info = agentManager.spawn({
				name: body.name as string,
				runtime: (body.runtime as "pi" | "custom") ?? "pi",
				cwd: body.cwd as string | undefined,
				provider: body.provider as string | undefined,
				model: body.model as string | undefined,
				tools: body.tools as string | undefined,
				systemPrompt: body.systemPrompt as string | undefined,
				sessionId: body.sessionId as string | undefined,
				resumeSession: body.resumeSession as boolean | undefined,
			});
			return reply.status(201).send(info);
		} catch (err) {
			return reply.status(409).send({
				error: err instanceof Error ? err.message : "spawn failed",
			});
		}
	});

	// ── List ───────────────────────────────────────

	app.get("/agents", async (_req, reply) => {
		return reply.send(agentManager.listAgents());
	});

	// ── Get one ────────────────────────────────────

	app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
		try {
			return reply.send(agentManager.getAgentInfo(req.params.id));
		} catch {
			return reply.status(404).send({ error: "agent not found" });
		}
	});

	// ── Prompt ─────────────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/agents/:id/prompt",
		async (req, reply) => {
			const body = req.body as Record<string, unknown>;
			const message = body.message as string | undefined;
			if (!message) {
				return reply.status(400).send({ error: "message is required" });
			}
			try {
				agentManager.prompt(req.params.id, message);
				return reply.send({ ok: true });
			} catch {
				return reply.status(404).send({ error: "agent not found" });
			}
		},
	);

	// ── Abort ──────────────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/agents/:id/abort",
		async (req, reply) => {
			try {
				agentManager.abort(req.params.id);
				return reply.send({ ok: true });
			} catch {
				return reply.status(404).send({ error: "agent not found" });
			}
		},
	);

	// ── New session ────────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/agents/:id/new-session",
		async (req, reply) => {
			try {
				agentManager.newSession(req.params.id);
				return reply.send({ ok: true });
			} catch {
				return reply.status(404).send({ error: "agent not found" });
			}
		},
	);

	// ── Kill ───────────────────────────────────────

	app.delete<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
		agentManager.kill(req.params.id);
		return reply.send({ ok: true });
	});

	// ── Saved sessions on disk ─────────────────────

	app.get("/agents/sessions", async (_req, reply) => {
		return reply.send(agentManager.listSavedSessions());
	});
}
