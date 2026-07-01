import type { ServerWebSocket } from "bun";
import { loadConfig, validateConfig } from "./config";
import { PiSessionManager, type SessionOutput } from "./session";
import { listSessions } from "./tmux";

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length > 0) {
	console.error("Invalid config:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

const manager = new PiSessionManager(config);
const clients = new Set<ServerWebSocket<unknown>>();

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
				if (req.method === "POST" && action === "/abort") {
					const session = await manager.get(project);
					session.abort();
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
