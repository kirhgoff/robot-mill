import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function taskId(project: string, branch: string): string {
	return `${project}-${branch.replace(/\//g, "-")}`;
}

export function worktreePath(projectsDir: string, project: string, branch: string): string {
	return join(projectsDir, taskId(project, branch));
}

function git(cwd: string, args: string[]): { ok: boolean; output: string } {
	const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

export function ensureWorktree(baseDir: string, worktreeDir: string, branch: string): void {
	if (existsSync(worktreeDir)) return;
	const branchExists = git(baseDir, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok;
	const args = branchExists
		? ["worktree", "add", worktreeDir, branch]
		: ["worktree", "add", "-b", branch, worktreeDir];
	const res = git(baseDir, args);
	if (!res.ok) throw new Error(`git worktree add failed: ${res.output}`);
}

export function removeWorktree(baseDir: string, worktreeDir: string): void {
	git(baseDir, ["worktree", "remove", "--force", worktreeDir]);
	git(baseDir, ["worktree", "prune"]);
}
