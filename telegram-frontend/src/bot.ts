/**
 * Telegram bot that uses BackendClient to manage agents.
 *
 * Each Telegram chat gets its own pi agent (spawned on /start).
 * Agent output is streamed back to the chat via WebSocket.
 */

import { Telegraf } from "telegraf";
import pino from "pino";
import { BackendClient, type AgentInfo } from "./backend-client";

const TG_MAX_LEN = 4000;

export interface TelegramBotOptions {
	botToken: string;
	allowedChatIds: number[];
	backendBaseUrl: string;
	backendWsUrl: string;
	workspace: string;
	piProvider?: string;
	piModel?: string;
}

export class TelegramBot {
	private bot: Telegraf;
	private client: BackendClient;
	private opts: TelegramBotOptions;
	private log = pino({ name: "telegram-bot" });

	/**
	 * Maps chatId → agentId.
	 * One agent per chat.
	 */
	private chatAgents = new Map<number, string>();

	/**
	 * Accumulate text output per agent between agent_start and agent_end.
	 */
	private pendingText = new Map<string, string>();

	constructor(opts: TelegramBotOptions) {
		this.opts = opts;
		this.bot = new Telegraf(opts.botToken);
		this.client = new BackendClient({
			baseUrl: opts.backendBaseUrl,
			wsUrl: opts.backendWsUrl,
		});

		this.setupBotHandlers();
		this.setupWsHandlers();
	}

	async start(): Promise<void> {
		// Connect WebSocket to backend
		this.client.connect();

		// Start Telegram polling
		await this.bot.launch({ dropPendingUpdates: true });
		this.log.info("Telegram bot running");
	}

	stop(): void {
		this.bot.stop("shutdown");
		this.client.disconnect();
	}

	// ── Bot command handlers ─────────────────────────

	private setupBotHandlers(): void {
		this.bot.command("start", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) {
				return ctx.reply("❌ Not authorized.");
			}

			// Kill existing agent for this chat
			const existingId = this.chatAgents.get(ctx.chat.id);
			if (existingId) {
				try {
					await this.client.killAgent(existingId);
				} catch {
					// ignore
				}
			}

			try {
				const agent = await this.client.spawnAgent({
					name: `tg-${ctx.chat.id}`,
					cwd: this.opts.workspace,
					provider: this.opts.piProvider,
					model: this.opts.piModel,
					sessionId: `tg-${ctx.chat.id}`,
					resumeSession: true,
				});

				this.chatAgents.set(ctx.chat.id, agent.id);
				this.client.subscribe(agent.id);

				await ctx.reply(
					[
						"🟢 *Pi agent session started!*",
						"",
						"Just send me your prompts.",
						"",
						"*Commands:*",
						"`/start` — new session (kills current)",
						"`/stop` — end session",
						"`/new` — fresh conversation (same process)",
						"`/abort` — abort current operation",
						"`/status` — show session info",
						"`/system` — system-wide status",
					].join("\n"),
					{ parse_mode: "Markdown" },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown error";
				await ctx.reply(`❌ Failed to start agent: ${msg}`);
			}
		});

		this.bot.command("stop", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const agentId = this.chatAgents.get(ctx.chat.id);
			if (agentId) {
				try {
					await this.client.killAgent(agentId);
				} catch {
					// ignore
				}
				this.chatAgents.delete(ctx.chat.id);
				await ctx.reply("🔴 Session stopped.");
			} else {
				await ctx.reply("No active session. Use /start to begin.");
			}
		});

		this.bot.command("new", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const agentId = this.chatAgents.get(ctx.chat.id);
			if (agentId) {
				try {
					await this.client.newSession(agentId);
					await ctx.reply(
						"🔄 Fresh conversation started (agent process kept alive).",
					);
				} catch {
					await ctx.reply("❌ Failed to reset session.");
				}
			} else {
				await ctx.reply("No active session. Use /start to begin.");
			}
		});

		this.bot.command("abort", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const agentId = this.chatAgents.get(ctx.chat.id);
			if (agentId) {
				try {
					await this.client.abortAgent(agentId);
					await ctx.reply("⛔ Sent abort signal.");
				} catch {
					await ctx.reply("❌ Failed to abort.");
				}
			} else {
				await ctx.reply("No active session.");
			}
		});

		this.bot.command("status", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			const agentId = this.chatAgents.get(ctx.chat.id);
			if (agentId) {
				try {
					const info = await this.client.getAgent(agentId);
					await ctx.reply(
						`🟢 *Session active* · ${info.status}\nAgent: \`${info.id}\`\nWorkdir: \`${info.cwd}\``,
						{ parse_mode: "Markdown" },
					);
				} catch {
					await ctx.reply("🔴 Agent not found. Use /start to begin.");
					this.chatAgents.delete(ctx.chat.id);
				}
			} else {
				await ctx.reply("🔴 No active session. Use /start to begin.");
			}
		});

		this.bot.command("system", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;
			try {
				const status = await this.client.getStatus();
				const agentLines = status.agents.map(
					(a: AgentInfo) =>
						`  • \`${a.name}\` (${a.status}) — ${a.currentTask || "idle"}`,
				);
				await ctx.reply(
					[
						`⚙️ *System Status*`,
						`Uptime: ${Math.round(status.uptime / 1000)}s`,
						`Agents: ${status.agentCount}`,
						...agentLines,
					].join("\n"),
					{ parse_mode: "Markdown" },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown";
				await ctx.reply(`❌ Backend error: ${msg}`);
			}
		});

		// ── Default: forward text to agent ───────────

		this.bot.on("text", async (ctx) => {
			if (!this.isAllowed(ctx.chat.id)) return;

			let agentId = this.chatAgents.get(ctx.chat.id);

			// Auto-start if no session
			if (!agentId) {
				try {
					const agent = await this.client.spawnAgent({
						name: `tg-${ctx.chat.id}`,
						cwd: this.opts.workspace,
						provider: this.opts.piProvider,
						model: this.opts.piModel,
						sessionId: `tg-${ctx.chat.id}`,
						resumeSession: true,
					});
					agentId = agent.id;
					this.chatAgents.set(ctx.chat.id, agentId);
					this.client.subscribe(agentId);
					// Brief pause for pi to initialise
					await new Promise((r) => setTimeout(r, 300));
				} catch (err) {
					const msg = err instanceof Error ? err.message : "unknown";
					await ctx.reply(`❌ Could not start agent: ${msg}`);
					return;
				}
			}

			try {
				await this.client.promptAgent(agentId, ctx.message.text);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown";
				await ctx.reply(`❌ Prompt failed: ${msg}`);
			}
		});
	}

	// ── WebSocket event handlers ─────────────────────

	private setupWsHandlers(): void {
		this.client.on("ws:connected", () => {
			this.log.info("Connected to backend WebSocket");
		});

		this.client.on("ws:disconnected", () => {
			this.log.warn("Backend WebSocket disconnected");
		});

		this.client.on("ws:error", (err: Error) => {
			this.log.error({ err }, "Backend WebSocket error");
		});

		// Route agent output back to the correct Telegram chat
		this.client.on("ws:message", (msg: Record<string, unknown>) => {
			const agentId = msg.agentId as string | undefined;
			if (!agentId) return;

			const chatId = this.agentToChatId(agentId);
			if (!chatId) return;

			this.handleAgentEvent(chatId, agentId, msg);
		});
	}

	private handleAgentEvent(
		chatId: number,
		agentId: string,
		event: Record<string, unknown>,
	): void {
		const type = event.type as string;

		switch (type) {
			case "status_change": {
				const data = event.data as Record<string, unknown>;
				if (data.status === "running") {
					this.pendingText.set(agentId, "");
				}
				break;
			}

			case "text": {
				// Accumulate text deltas
				const current = this.pendingText.get(agentId) || "";
				this.pendingText.set(agentId, current + ((event.data as string) || ""));
				break;
			}

			case "message_complete": {
				// Send the complete message
				const text = (event.data as string) || "";
				if (text.trim()) {
					this.sendChunked(chatId, text.trim());
				}
				this.pendingText.delete(agentId);
				break;
			}

			case "tool_start": {
				const data = event.data as Record<string, unknown>;
				if (data.toolName === "bash") {
					const cmd = (data.args as Record<string, string>)?.command ?? "...";
					const preview = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
					this.tg(chatId, `🔧 \`${preview}\``);
				}
				break;
			}

			case "agent_exit": {
				const data = event.data as Record<string, unknown>;
				this.tg(chatId, `🔴 Agent exited (code ${data.code ?? "?"})`);
				this.chatAgents.delete(chatId);
				this.pendingText.delete(agentId);
				break;
			}
		}
	}

	// ── Helpers ──────────────────────────────────────

	private isAllowed(chatId: number): boolean {
		if (this.opts.allowedChatIds.length === 0) return true;
		return this.opts.allowedChatIds.includes(chatId);
	}

	/** Reverse lookup: agentId → chatId. */
	private agentToChatId(agentId: string): number | null {
		for (const [chatId, aId] of this.chatAgents) {
			if (aId === agentId) return chatId;
		}
		return null;
	}

	private tg(chatId: number, text: string): void {
		this.bot.telegram
			.sendMessage(chatId, text, { parse_mode: "Markdown" })
			.catch(() => this.bot.telegram.sendMessage(chatId, text).catch(() => {}));
	}

	private sendChunked(chatId: number, text: string): void {
		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > TG_MAX_LEN) {
			chunks.push(remaining.slice(0, TG_MAX_LEN));
			remaining = remaining.slice(TG_MAX_LEN);
		}
		if (remaining) chunks.push(remaining);

		(async () => {
			for (const chunk of chunks) {
				await this.bot.telegram
					.sendMessage(chatId, chunk, {
						parse_mode: "Markdown",
					})
					.catch(() =>
						this.bot.telegram.sendMessage(chatId, chunk).catch(() => {}),
					);
			}
		})();
	}
}
