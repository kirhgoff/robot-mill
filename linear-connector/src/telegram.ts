export async function notify(botToken: string, chatId: string, text: string): Promise<void> {
	if (!botToken || !chatId) return;
	try {
		await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
		});
	} catch {}
}
