import type { Dispatcher } from "./dispatcher";
import type { Notifier } from "./notifier";
import type { Store } from "./store";
import type { Tasks } from "./tasks";

const messageLimit = 4000;
const pollSeconds = 50;
const offsetKey = "telegram_offset";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ json(): Promise<unknown> }>;

type Update = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
};

export type TelegramConfig = { token: string; chatId: string; fetch?: Fetch };

export function createTelegramApi(config: TelegramConfig) {
  const doFetch = config.fetch ?? (fetch as Fetch);
  return async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await doFetch(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!result.ok) throw new Error(`telegram ${method}: ${result.description ?? "failed"}`);
    return result.result;
  };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;

function chunks(text: string) {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += messageLimit) parts.push(text.slice(start, start + messageLimit));
  return parts.length ? parts : [""];
}

export function createTelegramNotifier(api: TelegramApi, chatId: string, store: Store): Notifier {
  async function sendAll(text: string) {
    const ids: number[] = [];
    for (const part of chunks(text)) {
      const sent = await api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: part });
      ids.push(sent.message_id);
    }
    return ids;
  }

  return {
    async send(text) {
      return (await sendAll(text))[0] as number;
    },
    async ask(taskId, text) {
      const ids = await sendAll(`❓ ${text}`);
      for (const id of ids) store.addQuestion(id, taskId);
      return ids[0] as number;
    },
  };
}

export type BotDeps = { api: TelegramApi; chatId: string; store: Store; tasks: Tasks; dispatcher: Dispatcher };

export function createBot({ api, chatId, store, tasks, dispatcher }: BotDeps) {
  async function reply(text: string) {
    await api("sendMessage", { chat_id: chatId, text });
  }

  async function route(message: NonNullable<Update["message"]>) {
    const text = message.text;
    if (!text) return;
    if (text.trim() === "/reset") {
      await dispatcher.reset();
      await reply("dispatcher reset");
      return;
    }
    const taskId = message.reply_to_message && store.questionTask(message.reply_to_message.message_id);
    const task = taskId ? tasks.get(taskId) : null;
    if (task) await tasks.answer(task, `Kirill answers: ${text}`);
    else await dispatcher.send(`[telegram] ${text}`);
  }

  async function handle(update: Update) {
    store.setKv(offsetKey, String(update.update_id + 1));
    if (!update.message || String(update.message.chat.id) !== chatId) return;
    try {
      await route(update.message);
    } catch (error) {
      console.error("telegram: could not route message", error);
    }
  }

  async function pollOnce() {
    const offset = Number(store.getKv(offsetKey) ?? 0);
    const updates = await api<Update[]>("getUpdates", { offset, timeout: pollSeconds, allowed_updates: ["message"] });
    for (const update of updates) await handle(update);
  }

  async function run() {
    for (;;) {
      try {
        await pollOnce();
      } catch (error) {
        console.error("telegram: poll failed", error);
        await Bun.sleep(5000);
      }
    }
  }

  return { pollOnce, run };
}
