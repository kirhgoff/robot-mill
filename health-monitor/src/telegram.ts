import type { Config } from "./config";

export async function notify(config: Config, text: string): Promise<void> {
	if (!config.telegramBotToken || !config.telegramChatId) return;
	try {
		await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				chat_id: config.telegramChatId,
				text,
				disable_web_page_preview: true,
			}),
		});
	} catch {}
}
