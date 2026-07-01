/**
 * telegram-frontend entry point.
 *
 * Reads config from env, creates the bot, and starts it.
 */

import { TelegramBot } from "./bot";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN is required");
	process.exit(1);
}

const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
	.map((s) => {
		const id = Number(s);
		if (!Number.isInteger(id)) {
			console.error(`Invalid ALLOWED_CHAT_IDS entry: "${s}"`);
			process.exit(1);
		}
		return id;
	});

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3100";
const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "ws://localhost:3100/ws";
const WORKSPACE = process.env.WORKSPACE || "/workspace";

const bot = new TelegramBot({
	botToken: BOT_TOKEN,
	allowedChatIds: ALLOWED_CHAT_IDS,
	backendBaseUrl: BACKEND_URL,
	backendWsUrl: BACKEND_WS_URL,
	workspace: WORKSPACE,
	piProvider: process.env.PI_PROVIDER || "anthropic",
	piModel: process.env.PI_MODEL || undefined,
});

bot.start().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
