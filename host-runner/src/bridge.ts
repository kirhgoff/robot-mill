import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("dir");
const socketPath = arg("socket");
const session = arg("session");
const provider = arg("provider");
const model = arg("model");

if (!dir || !socketPath || !session || !provider) {
	console.error("bridge requires --dir --socket --session --provider");
	process.exit(1);
}

mkdirSync(dirname(socketPath), { recursive: true });
mkdirSync(dirname(session), { recursive: true });
if (existsSync(socketPath)) unlinkSync(socketPath);

const piArgs = ["--mode", "rpc", "--session", session, "--provider", provider];
if (model) piArgs.push("--model", model);
if (existsSync(session)) piArgs.push("-c");

console.log(`[bridge] pi ${piArgs.join(" ")} (cwd ${dir})`);

const pi = spawn("pi", piArgs, { cwd: dir, env: process.env });
const clients = new Set<Socket>();

pi.stdout.setEncoding("utf-8");
pi.stdout.on("data", (chunk: string) => {
	printActivity(chunk);
	for (const client of clients) client.write(chunk);
});
pi.stderr.setEncoding("utf-8");
pi.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
pi.on("exit", (code) => {
	console.log(`[bridge] pi exited (${code})`);
	process.exit(code ?? 0);
});

const server = createServer((client: Socket) => {
	clients.add(client);
	client.on("data", (data) => pi.stdin.write(data));
	client.on("close", () => clients.delete(client));
	client.on("error", () => clients.delete(client));
});

server.listen(socketPath, () => console.log(`[bridge] listening ${socketPath}`));

function printActivity(chunk: string): void {
	for (const line of chunk.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_update") {
				const mev = event.assistantMessageEvent;
				if (mev?.type === "text_delta") process.stdout.write(mev.delta);
			} else if (event.type === "tool_execution_start") {
				console.log(`\n[tool] ${event.toolName}`);
			} else if (event.type === "agent_end") {
				process.stdout.write("\n");
			}
		} catch {
			process.stdout.write(line);
		}
	}
}
