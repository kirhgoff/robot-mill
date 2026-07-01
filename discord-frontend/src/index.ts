import { DiscordBot } from "./bot";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) {
	console.error("DISCORD_BOT_TOKEN is required");
	process.exit(1);
}

const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const bot = new DiscordBot({
	botToken: BOT_TOKEN,
	allowedChannelIds: ALLOWED_CHANNEL_IDS,
	commandPrefix: process.env.DISCORD_COMMAND_PREFIX || "!",
	backendBaseUrl: process.env.BACKEND_URL || "http://localhost:3100",
	backendWsUrl: process.env.BACKEND_WS_URL || "ws://localhost:3100/ws",
	hostRunnerBaseUrl:
		process.env.HOST_RUNNER_URL || "http://host.docker.internal:3200",
	hostRunnerWsUrl:
		process.env.HOST_RUNNER_WS_URL || "ws://host.docker.internal:3200/ws",
	workspace: process.env.WORKSPACE || "/workspace",
	piProvider: process.env.PI_PROVIDER || "anthropic",
	piModel: process.env.PI_MODEL || undefined,
});

bot.start().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
