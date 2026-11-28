import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp";
import type { Tasks } from "./tasks";

export function startServer(port: number, tasks: Tasks) {
  async function handleMcp(request: Request, session: string) {
    const server = createMcpServer(tasks, session);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  async function handleTurnEnd(request: Request, session: string) {
    const payload = await request.json().catch(() => ({}));
    tasks.onTurnEnd(session, payload);
    return new Response("ok");
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const session = url.searchParams.get("session");
      if (!session) return new Response("session required", { status: 400 });
      if (url.pathname === "/mcp") return handleMcp(request, session);
      if (url.pathname === "/hook/turn-end" && request.method === "POST") return handleTurnEnd(request, session);
      return new Response("not found", { status: 404 });
    },
  });
}
