import { readFileSync } from "node:fs";

export const requiredKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
];

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = (match[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value) values[match[1] ?? ""] = value;
  }
  return values;
}

export function loadEnv(path: string, env: Record<string, string | undefined> = process.env) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) env[key] ??= value;
  const missing = requiredKeys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`${path} is missing: ${missing.join(", ")}`);
}
