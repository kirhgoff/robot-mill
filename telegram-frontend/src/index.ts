import { TelegramBot } from "./bot";

function env(key: string, fallback = ""): string {
	return process.env[key] || fallback;
}

const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
if (!BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN is required");
	process.exit(1);
}

const ALLOWED_CHAT_IDS = env("ALLOWED_CHAT_IDS")
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

const HOST_RUNNER_URL = env("HOST_RUNNER_URL", "http://host.docker.internal:3200");
const HOST_RUNNER_WS_URL = env("HOST_RUNNER_WS_URL", "ws://host.docker.internal:3200/ws");
const LINEAR_URL = env("LINEAR_URL", "http://host.docker.internal:3400");
const STATE_FILE = env("STATE_FILE", "/data/telegram/state.json");

const bot = new TelegramBot({
	botToken: BOT_TOKEN,
	allowedChatIds: ALLOWED_CHAT_IDS,
	hostRunnerBaseUrl: HOST_RUNNER_URL,
	hostRunnerWsUrl: HOST_RUNNER_WS_URL,
	linearUrl: LINEAR_URL,
	stateFile: STATE_FILE,
});

bot.start().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
