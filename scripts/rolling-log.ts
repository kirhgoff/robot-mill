import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [, , dir, name] = process.argv;
if (!dir || !name) {
	console.error("usage: rolling-log.ts <dir> <name>");
	process.exit(1);
}

const keepDays = Number(process.env.LOG_KEEP_DAYS || "14");

function today(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function pathFor(date: string): string {
	return join(dir, `${name}-${date}.log`);
}

function pruneOld(): void {
	const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
	const prefix = `${name}-`;
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".log")) continue;
		const full = join(dir, entry);
		if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
	}
}

mkdirSync(dir, { recursive: true });
try {
	unlinkSync(join(dir, `${name}.log`));
} catch {}
pruneOld();

let date = today();
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
	const current = today();
	if (current !== date) {
		date = current;
		pruneOld();
	}
	appendFileSync(pathFor(date), `${line}\n`);
	console.log(line);
});
