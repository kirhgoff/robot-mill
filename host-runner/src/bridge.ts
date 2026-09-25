import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
const statusFile = arg("status");

if (!dir || !socketPath || !session || !provider || !statusFile) {
	console.error("bridge requires --dir --socket --session --provider --status");
	process.exit(1);
}

const statusPath: string = statusFile;

mkdirSync(dirname(socketPath), { recursive: true });
mkdirSync(dirname(session), { recursive: true });
mkdirSync(dirname(statusPath), { recursive: true });
if (existsSync(socketPath)) unlinkSync(socketPath);

let busy = false;
let startedAt: number | null = null;
let endedAt: number | null = null;
let lastText: string | null = null;
let pendingText = "";

function writeStatus(): void {
	const tmp = `${statusPath}.tmp`;
	writeFileSync(tmp, JSON.stringify({ busy, startedAt, endedAt, lastText }));
	renameSync(tmp, statusPath);
}

function updateStatus(chunk: string): void {
	for (const line of chunk.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "agent_start") {
				busy = true;
				startedAt = Date.now();
				endedAt = null;
				lastText = null;
				pendingText = "";
				writeStatus();
			} else if (event.type === "message_update") {
				const mev = event.assistantMessageEvent;
				if (mev?.type === "text_delta") pendingText += mev.delta;
			} else if (event.type === "message_end") {
				const message = event.message;
				if (
					message?.role === "assistant" &&
					message.stopReason === "error" &&
					typeof message.errorMessage === "string" &&
					message.errorMessage.trim()
				) {
					pendingText = `agent error: ${message.errorMessage}`;
				}
			} else if (event.type === "agent_end") {
				busy = false;
				endedAt = Date.now();
				lastText = pendingText.trim();
				pendingText = "";
				writeStatus();
			}
		} catch {
			// malformed line
		}
	}
}

const piArgs = ["--mode", "rpc", "--session", session, "--provider", provider];
if (model) piArgs.push("--model", model);
if (existsSync(session)) piArgs.push("-c");

console.log(`[bridge] pi ${piArgs.join(" ")} (cwd ${dir})`);

const pi = spawn("pi", piArgs, { cwd: dir, env: process.env });
const clients = new Set<Socket>();

pi.stdout.setEncoding("utf-8");
pi.stdout.on("data", (chunk: string) => {
	printActivity(chunk);
	updateStatus(chunk);
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
