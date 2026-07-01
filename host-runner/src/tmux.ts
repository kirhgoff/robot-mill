import { spawnSync } from "node:child_process";

export function sessionName(project: string): string {
	return `pi-${project}`;
}

export function hasSession(project: string): boolean {
	const res = spawnSync("tmux", ["has-session", "-t", sessionName(project)], {
		stdio: "ignore",
	});
	return res.status === 0;
}

export function listSessions(): string[] {
	const res = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
		encoding: "utf-8",
	});
	if (res.status !== 0) return [];
	return res.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.startsWith("pi-"))
		.map((s) => s.slice(3));
}

export function newSession(
	project: string,
	cwd: string,
	command: string,
	envVars: Record<string, string>,
): void {
	const args = ["new-session", "-d", "-s", sessionName(project), "-c", cwd];
	for (const [key, value] of Object.entries(envVars)) {
		args.push("-e", `${key}=${value}`);
	}
	args.push(command);
	const res = spawnSync("tmux", args, { encoding: "utf-8" });
	if (res.status !== 0) {
		throw new Error(`tmux new-session failed: ${res.stderr || res.stdout}`);
	}
}

export function killSession(project: string): void {
	spawnSync("tmux", ["kill-session", "-t", sessionName(project)], {
		stdio: "ignore",
	});
}
