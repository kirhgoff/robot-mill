/**
 * REST routes for variation management.
 *
 * POST   /variations              — create a new variation
 * GET    /variations              — list all variations
 * GET    /variations/:id          — get a single variation
 * GET    /variations/:id/diff     — get git diff
 * GET    /variations/:id/log      — get git log
 * GET    /variations/:id/files    — get changed files
 * POST   /variations/:id/start    — start dev server
 * POST   /variations/:id/stop     — stop dev server
 * POST   /variations/:id/refresh  — refresh Main variation from origin
 * POST   /variations/:id/chat     — send message to agent
 * DELETE /variations/:id          — delete variation
 * GET    /target/config           — get target project configuration
 * PUT    /target/config           — update target project configuration
 * POST   /target/refresh          — fetch latest commits from origin
 * GET    /target/branches         — list branches in the source repo
 */

import type { FastifyInstance } from "fastify";
import type { VariationManager } from "../../variation-manager/index";

export function registerVariationRoutes(
	app: FastifyInstance,
	variationManager: VariationManager,
) {
	// ── Create ─────────────────────────────────────

	app.post("/variations", async (req, reply) => {
		const body = req.body as Record<string, unknown>;

		if (!body.title || typeof body.title !== "string") {
			return reply.status(400).send({ error: "title is required" });
		}
		if (!body.prompt || typeof body.prompt !== "string") {
			return reply.status(400).send({ error: "prompt is required" });
		}

		try {
			const variation = await variationManager.create({
				title: body.title as string,
				prompt: body.prompt as string,
				sourceRepo: body.sourceRepo as string | undefined,
				baseBranch: body.baseBranch as string | undefined,
			});
			return reply.status(201).send(variation);
		} catch (err) {
			return reply.status(500).send({
				error: err instanceof Error ? err.message : "creation failed",
			});
		}
	});

	// ── List ───────────────────────────────────────

	app.get("/variations", async (_req, reply) => {
		const variations = variationManager.list();

		// Enrich with changed file counts (best-effort)
		const enriched = await Promise.all(
			variations.map(async (v) => {
				try {
					const files = await variationManager.getChangedFiles(v.id);
					return { ...v, changedFileCount: files.length };
				} catch {
					return { ...v, changedFileCount: 0 };
				}
			}),
		);

		return reply.send(enriched);
	});

	// ── Get one ────────────────────────────────────

	app.get<{ Params: { id: string } }>("/variations/:id", async (req, reply) => {
		try {
			const variation = variationManager.get(req.params.id);
			const files = await variationManager
				.getChangedFiles(req.params.id)
				.catch(() => []);
			return reply.send({
				...variation,
				changedFileCount: files.length,
				changedFiles: files,
			});
		} catch {
			return reply.status(404).send({ error: "variation not found" });
		}
	});

	// ── Diff ───────────────────────────────────────

	app.get<{ Params: { id: string } }>(
		"/variations/:id/diff",
		async (req, reply) => {
			try {
				const diff = await variationManager.getDiff(req.params.id);
				return reply.send(diff);
			} catch (err) {
				return reply.status(404).send({
					error: err instanceof Error ? err.message : "variation not found",
				});
			}
		},
	);

	// ── Log ────────────────────────────────────────

	app.get<{ Params: { id: string } }>(
		"/variations/:id/log",
		async (req, reply) => {
			try {
				const log = await variationManager.getLog(req.params.id);
				return reply.send({ log });
			} catch (err) {
				return reply.status(404).send({
					error: err instanceof Error ? err.message : "variation not found",
				});
			}
		},
	);

	// ── Changed files ──────────────────────────────

	app.get<{ Params: { id: string } }>(
		"/variations/:id/files",
		async (req, reply) => {
			try {
				const files = await variationManager.getChangedFiles(req.params.id);
				return reply.send({ files });
			} catch (err) {
				return reply.status(404).send({
					error: err instanceof Error ? err.message : "variation not found",
				});
			}
		},
	);

	// ── Messages (chat history) ──────────────────

	app.get<{ Params: { id: string } }>(
		"/variations/:id/messages",
		async (req, reply) => {
			try {
				const messages = variationManager.getMessages(req.params.id);
				return reply.send({ messages });
			} catch (err) {
				return reply.status(404).send({
					error: err instanceof Error ? err.message : "variation not found",
				});
			}
		},
	);

	// ── Start server ───────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/variations/:id/start",
		async (req, reply) => {
			try {
				const variation = await variationManager.startServer(req.params.id);
				return reply.send(variation);
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : "start failed",
				});
			}
		},
	);

	// ── Refresh (Main variation only) ──────────────

	app.post<{ Params: { id: string } }>(
		"/variations/:id/refresh",
		async (req, reply) => {
			try {
				const variation = await variationManager.refreshMain(req.params.id);
				return reply.send(variation);
			} catch (err) {
				return reply.status(400).send({
					error: err instanceof Error ? err.message : "refresh failed",
				});
			}
		},
	);

	// ── Stop server ────────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/variations/:id/stop",
		async (req, reply) => {
			try {
				const variation = variationManager.stopServer(req.params.id);
				return reply.send(variation);
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : "stop failed",
				});
			}
		},
	);

	// ── Chat ───────────────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/variations/:id/chat",
		async (req, reply) => {
			const body = req.body as Record<string, unknown>;
			const message = body.message as string | undefined;

			if (!message) {
				return reply.status(400).send({ error: "message is required" });
			}

			try {
				await variationManager.chat(req.params.id, message);
				return reply.send({ ok: true });
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : "chat failed",
				});
			}
		},
	);

	// ── Pull request ──────────────────────────────

	app.post<{ Params: { id: string } }>(
		"/variations/:id/pull-request",
		async (req, reply) => {
			try {
				const prUrl = await variationManager.createPullRequest(req.params.id);
				return reply.send({ ok: true, url: prUrl });
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : "pull request failed",
				});
			}
		},
	);

	// ── Delete ─────────────────────────────────────

	app.delete<{ Params: { id: string } }>(
		"/variations/:id",
		async (req, reply) => {
			try {
				await variationManager.delete(req.params.id);
				return reply.send({ ok: true });
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : "delete failed",
				});
			}
		},
	);

	// ── Config ─────────────────────────────────────

	app.get("/target/config", async (_req, reply) => {
		return reply.send(variationManager.getConfig());
	});

	app.put("/target/config", async (req, reply) => {
		const body = req.body as Record<string, unknown>;
		const config = variationManager.updateConfig({
			sourceRepo: body.sourceRepo as string | undefined,
			portRangeMin: body.portRangeMin as number | undefined,
			portRangeMax: body.portRangeMax as number | undefined,
		});
		return reply.send(config);
	});

	// ── Refresh source repo (fetch latest from origin) ───────────

	app.post("/target/refresh", async (_req, reply) => {
		try {
			await variationManager.refreshSource();
			return reply.send({ ok: true });
		} catch (err) {
			return reply.status(500).send({
				error: err instanceof Error ? err.message : "refresh failed",
			});
		}
	});

	// ── List branches in the source repo ────────────────────────

	app.get("/target/branches", async (_req, reply) => {
		try {
			const branches = await variationManager.listBranches();
			return reply.send({ branches });
		} catch (err) {
			return reply.status(500).send({
				error: err instanceof Error ? err.message : "list branches failed",
			});
		}
	});
}
