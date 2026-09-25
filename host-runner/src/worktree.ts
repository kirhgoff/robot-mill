import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function taskId(project: string, name: string): string {
	return `${project}-${name}`;
}

function git(cwd: string, args: string[]): { ok: boolean; output: string } {
	const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function defaultBranch(baseDir: string): string {
	const res = git(baseDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (!res.ok) return "main";
	return res.output.replace(/^origin\//, "") || "main";
}

function linkSiblings(baseDir: string, worktreeDir: string): void {
	for (const entry of readdirSync(baseDir)) {
		const src = join(baseDir, entry);
		if (!lstatSync(src).isSymbolicLink()) continue;
		const dest = join(worktreeDir, entry);
		if (existsSync(dest)) continue;
		symlinkSync(readlinkSync(src), dest);
	}
}

export function ensureWorktree(baseDir: string, worktreeDir: string, branch: string): void {
	if (existsSync(worktreeDir)) return;
	git(baseDir, ["fetch", "origin"]);
	const branchExists = git(baseDir, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok;
	const args = branchExists
		? ["worktree", "add", worktreeDir, branch]
		: ["worktree", "add", "-b", branch, worktreeDir, `origin/${defaultBranch(baseDir)}`];
	mkdirSync(dirname(worktreeDir), { recursive: true });
	const res = git(baseDir, args);
	if (!res.ok) throw new Error(`git worktree add failed: ${res.output}`);
	linkSiblings(baseDir, worktreeDir);
}

export function removeWorktree(baseDir: string, worktreeDir: string): void {
	git(baseDir, ["worktree", "remove", "--force", worktreeDir]);
	git(baseDir, ["worktree", "prune"]);
}
