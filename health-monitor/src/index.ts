import { loadConfig } from "./config";
import { Monitor } from "./monitor";

const config = loadConfig();
const monitor = new Monitor(config);
monitor.start();

function overall(results: { status: string }[]): string {
	if (results.some((r) => r.status === "fail" || r.status === "error")) return "degraded";
	if (results.some((r) => r.status === "unknown")) return "unknown";
	if (results.length === 0) return "starting";
	return "ok";
}

const server = Bun.serve({
	hostname: "0.0.0.0",
	port: config.port,
	fetch(req) {
		const url = new URL(req.url);
		const results = monitor.snapshot();
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ overall: overall(results), checks: results }, null, 2), {
				headers: { "content-type": "application/json" },
			});
		}
		if (req.method === "POST" && url.pathname.startsWith("/check/")) {
			const project = decodeURIComponent(url.pathname.slice("/check/".length));
			void monitor.recheck(project);
			return new Response(JSON.stringify({ ok: true, project }), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/" || url.pathname === "/status") {
			const lines = results.map(
				(r) => `${icon(r.status)} ${r.name.padEnd(18)} ${r.status.toUpperCase().padEnd(8)} ${r.detail}`,
			);
			const body = [`robot-mill health: ${overall(results).toUpperCase()}`, "", ...lines, ""].join("\n");
			return new Response(body, { headers: { "content-type": "text/plain" } });
		}
		return new Response("not found", { status: 404 });
	},
});

function icon(status: string): string {
	return status === "ok" ? "🟢" : status === "fail" || status === "error" ? "🔴" : "🟡";
}

console.log(`health-monitor listening on http://0.0.0.0:${server.port}`);
