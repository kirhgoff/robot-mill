import type { ServerWebSocket } from "bun";
import { spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "./config";
import { PiSessionManager, type SessionOutput } from "./session";
import { listSessions } from "./tmux";
import { taskId } from "./worktree";

process.on("uncaughtException", (err) => {
	console.error("uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
	console.error("unhandledRejection:", reason);
});

function diskStats(path: string): { free: number; total: number } {
	const res = spawnSync("df", ["-kP", path], { encoding: "utf-8" });
	const line = (res.stdout || "").trim().split("\n")[1] || "";
	const cols = line.split(/\s+/);
	return { total: (Number(cols[1]) || 0) * 1024, free: (Number(cols[3]) || 0) * 1024 };
}

function systemStats() {
	return { mem: { free: freemem(), total: totalmem() }, disk: diskStats(config.projectsDir) };
}

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length > 0) {
	console.error("Invalid config:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

const manager = new PiSessionManager(config);
const clients = new Set<ServerWebSocket<unknown>>();

interface CreditsInfo {
	provider: string;
	available: boolean;
	total?: number;
	usage?: number;
	remaining?: number;
}

const CREDITS_TTL_MS = 60_000;
let creditsCache: { at: number; data: CreditsInfo } | null = null;

async function fetchCredits(): Promise<CreditsInfo> {
	if (config.piProvider !== "openrouter") return { provider: config.piProvider, available: false };
	const key = config.providerKey;
	if (!key) return { provider: config.piProvider, available: false };
	const res = await fetch("https://openrouter.ai/api/v1/credits", {
		headers: { authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) return { provider: config.piProvider, available: false };
	const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
	const total = Number(body.data?.total_credits ?? 0);
	const usage = Number(body.data?.total_usage ?? 0);
	return { provider: config.piProvider, available: true, total, usage, remaining: total - usage };
}

async function credits(): Promise<CreditsInfo> {
	if (creditsCache && Date.now() - creditsCache.at < CREDITS_TTL_MS) return creditsCache.data;
	const data = await fetchCredits().catch(() => ({ provider: config.piProvider, available: false }));
	creditsCache = { at: Date.now(), data };
	return data;
}

manager.on("output", (output: SessionOutput) => broadcast(output));

function broadcast(payload: unknown): void {
	const data = JSON.stringify(payload);
	for (const client of clients) {
		try {
			client.send(data);
		} catch {
			// dropped on close
		}
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	async fetch(req, server) {
		const url = new URL(req.url);
		const path = url.pathname;

		if (path === "/ws") {
			if (server.upgrade(req)) return undefined as unknown as Response;
			return new Response("expected websocket", { status: 400 });
		}

		if (path === "/health_check") return json({ status: "ok" });

		if (path === "/system") return json(systemStats());

		if (path === "/credits") return json(await credits());

		if (path === "/projects" && req.method === "GET") {
			return json({ allowed: manager.listProjects(), running: listSessions() });
		}

		const match = path.match(/^\/projects\/([^/]+)(\/[a-z-]+)?$/);
		if (match) {
			const project = decodeURIComponent(match[1]);
			const action = match[2];
			if (!manager.isAllowed(project)) {
				return json({ error: `project not allowed: ${project}` }, 403);
			}

			try {
				if (req.method === "POST" && action === "/prompt") {
					const body = await readBody(req);
					const message = body.message as string | undefined;
					if (!message) return json({ error: "message is required" }, 400);
					const session = await manager.get(project);
					session.prompt(message);
					return json({ ok: true });
				}
					if (req.method === "POST" && action === "/diagnose") {
						const body = await readBody(req);
						const message = body.message as string | undefined;
						if (!message) return json({ error: "message is required" }, 400);
						const timeoutMs = Number(body.timeoutMs ?? 5 * 60 * 1000);
						const text = await manager.diagnose(project, message, timeoutMs);
						return json({ ok: true, text });
					}
					if (req.method === "POST" && action === "/task") {
						const body = await readBody(req);
						const name = body.name as string | undefined;
						const message = body.message as string | undefined;
						const worktree = body.worktree === undefined ? true : Boolean(body.worktree);
						const model = body.model as string | undefined;
						const provider = body.provider as string | undefined;
						if (!name || !message) {
							return json({ error: "name and message are required" }, 400);
						}
						if (!/^[a-z0-9._-]+$/.test(name)) {
							return json({ error: "invalid name" }, 400);
						}
						const session = await manager.getTask(project, name, worktree);
						if (model) {
							await session.setModel(provider || config.piProvider, model);
						}
						session.prompt(message);
						const dir = worktree
							? join(config.worktreesDir, project, name)
							: join(config.projectsDir, project);
						return json({ ok: true, key: taskId(project, name), dir });
					}
					if (req.method === "GET" && action === "/task") {
						const name = url.searchParams.get("name");
						if (!name) return json({ error: "name is required" }, 400);
						return json(await manager.taskStatus(project, name));
					}
					if (req.method === "DELETE" && action === "/task") {
						const body = await readBody(req);
						const name = body.name as string | undefined;
						if (!name) return json({ error: "name is required" }, 400);
						manager.killTask(project, name);
						return json({ ok: true });
					}
					if (req.method === "POST" && action === "/restart") {
						const session = await manager.restart(project);
						return json({ ok: true, running: session.running });
					}
					if (req.method === "POST" && action === "/abort") {
						const body = await readBody(req);
						const name = body.name as string | undefined;
						await manager.abort(project, name);
						return json({ ok: true });
					}
				if (req.method === "POST" && action === "/new-session") {
					const session = await manager.get(project);
					session.newConversation();
					return json({ ok: true });
				}
				if (req.method === "DELETE" && !action) {
					manager.kill(project);
					return json({ ok: true });
				}
				if (req.method === "GET" && !action) {
					const session = await manager.get(project);
					return json({ project, running: session.running });
				}
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "failed" }, 500);
			}
		}

		return json({ error: "not found" }, 404);
	},
	websocket: {
		open(ws) {
			clients.add(ws);
		},
		close(ws) {
			clients.delete(ws);
		},
		message() {
			// clients only receive
		},
	},
});

console.log(`host-runner listening on http://${config.host}:${server.port}`);
console.log(`  projects dir: ${config.projectsDir}`);
console.log(`  allowed: ${config.allowedProjects.join(", ") || "(any under projects dir)"}`);
