import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import { Telegraf } from "telegraf";
import { HostRunnerClient } from "./host-runner-client";
import { LinearClient } from "./linear-client";

const TG_MAX_LEN = 4000;
const TICKET_RE = /^\/(?:ticket|ops)(?:@\S+)?\s+(\S+)\s+([^\n]+)\n?([\s\S]*)$/;

export interface TelegramBotOptions {
	botToken: string;
	allowedChatIds: number[];
	hostRunnerBaseUrl: string;
	hostRunnerWsUrl: string;
	linearUrl: string;
	stateFile: string;
}

function splitChunks(text: string, max: number): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > max) {
		chunks.push(remaining.slice(0, max));
		remaining = remaining.slice(max);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export class TelegramBot {
	private bot: Telegraf;
	private hostClient: HostRunnerClient;
	private linearClient: LinearClient;
	private opts: TelegramBotOptions;
	private log = pino({ name: "telegram-bot" });

	private chatProject = new Map<number, string>();
	private sendQueue = new Map<number, Promise<void>>();

	constructor(opts: TelegramBotOptions) {
		this.opts = opts;
		this.bot = new Telegraf(opts.botToken);
		this.hostClient = new HostRunnerClient({
			baseUrl: opts.hostRunnerBaseUrl,
			wsUrl: opts.hostRunnerWsUrl,
		});
		this.linearClient = new LinearClient({ baseUrl: opts.linearUrl });

		this.loadState();
		this.setupBotHandlers();
		this.setupHostWsHandlers();
	}

	async start(): Promise<void> {
		this.hostClient.connect();

		await this.bot.launch({ dropPendingUpdates: true });
		this.log.info("Telegram bot running");
	}

	stop(): void {
		this.bot.stop("shutdown");
		this.hostClient.disconnect();
	}

	private setupBotHandlers(): void {
		this.bot.command("project", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const name = ctx.message.text.split(/\s+/)[1]?.trim();
			let allowed: string[] = [];
			try {
				allowed = (await this.hostClient.listProjects()).allowed;
			} catch (err) {
				return this.send(ctx.chat.id, this.unreachable("host-runner", err));
			}
			if (!name) {
				return this.send(
					ctx.chat.id,
					[
						"*Host projects* — send `/project <name>` to work in one:",
						...allowed.map((p) => `• \`${p}\``),
					].join("\n"),
				);
			}
			if (!allowed.includes(name)) {
				return this.send(
					ctx.chat.id,
					`❌ Unknown project "${name}". Allowed: ${allowed.join(", ")}`,
				);
			}
			this.setProject(ctx.chat.id, name);
			this.send(
				ctx.chat.id,
				`🗂️ Now working in host project *${name}*. Send prompts to it directly.`,
			);
		});

		this.bot.command(["ticket", "ops"], async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const ops = ctx.message.text.startsWith("/ops");
			const match = ctx.message.text.match(TICKET_RE);
			if (!match) {
				return this.send(
					ctx.chat.id,
					`Usage: \`/${ops ? "ops" : "ticket"} <project> <title>\` then description on following lines.`,
				);
			}
			const [, project, title, description] = match;
			try {
				const result = await this.linearClient.createTicket({
					project,
					title: title.trim(),
					description: description.trim() || undefined,
					ops,
				});
				this.send(ctx.chat.id, `🎫 ${result.identifier} ${result.url}`);
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("linear-connector", err));
			}
		});

		this.bot.command("agents", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const lines: string[] = [];

			try {
				const projects = await this.hostClient.listProjects();
				lines.push("*Host projects running:*");
				lines.push(
					...(projects.running.length
						? projects.running.map((p) => `• \`${p}\``)
						: ["  (none)"]),
				);
			} catch (err) {
				lines.push(this.unreachable("host-runner", err));
			}

			try {
				const tasks = await this.linearClient.tasks();
				lines.push("*Linear tasks:*");
				lines.push(
					...(tasks.length
						? tasks.map((t) => {
								const age = Math.max(
									0,
									Math.round((Date.now() - t.startedAt) / 60_000),
								);
								return `• \`${t.identifier}\` ${t.project} (${t.mode}${t.phase ? `, ${t.phase}` : ""}) — ${t.title} (${age}m ago)`;
							})
						: ["  (none)"]),
				);
			} catch (err) {
				lines.push(this.unreachable("linear-connector", err));
			}

			const project = this.chatProject.get(ctx.chat.id);
			lines.push(`this chat → ${project ?? "none"}`);
			this.send(ctx.chat.id, lines.join("\n"));
		});

		this.bot.command("abort", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const arg = ctx.message.text.split(/\s+/)[1]?.trim();
			if (arg && /^[A-Z]+-\d+$/i.test(arg)) {
				try {
					await this.linearClient.abortTask(arg);
					this.send(ctx.chat.id, `⛔ Aborted ${arg}.`);
				} catch (err) {
					this.send(ctx.chat.id, this.unreachable("linear-connector", err));
				}
				return;
			}
			const project = this.chatProject.get(ctx.chat.id);
			if (!project) {
				return this.send(ctx.chat.id, "pick a project: `/project <name>`");
			}
			try {
				await this.hostClient.abort(project);
				this.send(ctx.chat.id, "⛔ Sent abort signal.");
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("host-runner", err));
			}
		});

		this.bot.command("new", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const project = this.chatProject.get(ctx.chat.id);
			if (!project) {
				return this.send(ctx.chat.id, "pick a project: `/project <name>`");
			}
			try {
				await this.hostClient.newConversation(project);
				this.send(ctx.chat.id, "🔄 Fresh conversation started.");
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("host-runner", err));
			}
		});

		this.bot.command("stop", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const project = this.chatProject.get(ctx.chat.id);
			if (!project) {
				return this.send(ctx.chat.id, "pick a project: `/project <name>`");
			}
			try {
				await this.hostClient.stop(project);
				this.send(ctx.chat.id, `🔴 Stopped ${project}.`);
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("host-runner", err));
			}
		});

		this.bot.command("poll", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			try {
				const result = await this.linearClient.poll();
				this.send(
					ctx.chat.id,
					`🔁 Polled Linear — dispatched ${result.dispatched}.`,
				);
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("linear-connector", err));
			}
		});

		this.bot.command("help", (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			this.send(
				ctx.chat.id,
				[
					"*Commands:*",
					"`/project <name>` — route this chat to a host project; plain text = prompt",
					"`/ticket <project> <title>` — file a Linear ticket (agent opens a PR)",
					"`/ops <project> <title>` — file an ops ticket (runbook, no PR)",
					"`/agents` — running host projects + active Linear tasks",
					"`/abort [KIR-123]` — abort a Linear task, or this chat's project",
					"`/new` — fresh conversation in this chat's project",
					"`/stop` — stop this chat's project agent",
					"`/poll` — poll Linear now",
				].join("\n"),
			);
		});

		this.bot.on("text", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const project = this.chatProject.get(ctx.chat.id);
			if (!project) {
				return this.send(ctx.chat.id, "pick a project: `/project <name>`");
			}
			try {
				await this.hostClient.prompt(project, ctx.message.text);
			} catch (err) {
				this.send(ctx.chat.id, this.unreachable("host-runner", err));
			}
		});
	}

	private setupHostWsHandlers(): void {
		this.hostClient.on("ws:connected", () =>
			this.log.info("Connected to host-runner"),
		);
		this.hostClient.on("ws:disconnected", () =>
			this.log.warn("Host-runner WS disconnected"),
		);
		this.hostClient.on("ws:message", (msg: Record<string, unknown>) => {
			const project = msg.project as string | undefined;
			if (!project) return;
			for (const [chatId, targeted] of this.chatProject) {
				if (targeted === project) this.handleHostEvent(chatId, msg);
			}
		});
	}

	private handleHostEvent(
		chatId: number,
		event: Record<string, unknown>,
	): void {
		const type = event.type as string;
		if (type === "message_complete") {
			const text = (event.data as string) || "";
			if (text.trim()) this.send(chatId, text.trim());
		} else if (type === "tool_start") {
			const data = event.data as Record<string, unknown>;
			if (data?.toolName === "bash") {
				const cmd = (data.args as Record<string, string>)?.command ?? "...";
				const preview = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
				this.send(chatId, `🔧 \`${preview}\``);
			}
		}
	}

	private loadState(): void {
		try {
			const raw = readFileSync(this.opts.stateFile, "utf-8");
			const data = JSON.parse(raw) as { chatProject?: Record<string, string> };
			for (const [chatId, project] of Object.entries(data.chatProject ?? {})) {
				this.chatProject.set(Number(chatId), project);
			}
		} catch {}
	}

	private saveState(): void {
		const chatProject: Record<string, string> = {};
		for (const [chatId, project] of this.chatProject) chatProject[chatId] = project;
		mkdirSync(dirname(this.opts.stateFile), { recursive: true });
		writeFileSync(this.opts.stateFile, JSON.stringify({ chatProject }));
	}

	private setProject(chatId: number, project: string): void {
		this.chatProject.set(chatId, project);
		this.saveState();
	}

	private isAllowed(chatId: number): boolean {
		if (this.opts.allowedChatIds.length === 0) return true;
		return this.opts.allowedChatIds.includes(chatId);
	}

	private unreachable(service: string, err: unknown): string {
		const msg = err instanceof Error ? err.message : "unknown error";
		return `❌ ${service} unreachable: ${msg}`;
	}

	private send(chatId: number, text: string): void {
		for (const chunk of splitChunks(text, TG_MAX_LEN)) {
			const prior = this.sendQueue.get(chatId) ?? Promise.resolve();
			const next = prior.catch(() => {}).then(() => this.deliver(chatId, chunk));
			this.sendQueue.set(chatId, next);
		}
	}

	private async deliver(chatId: number, text: string): Promise<void> {
		try {
			await this.bot.telegram.sendMessage(chatId, text, {
				parse_mode: "Markdown",
			});
		} catch {
			await this.bot.telegram.sendMessage(chatId, text).catch(() => {});
		}
	}
}
