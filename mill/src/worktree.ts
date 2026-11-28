import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Runner, runOrThrow } from "./run";

export type Git = {
  ensureClone(repo: string): Promise<void>;
  addWorktree(repo: string, branch: string): Promise<string>;
  addPrWorktree(repo: string, pr: number): Promise<string>;
  removeWorktree(repo: string, branch: string): Promise<void>;
};

export function createGit(projects: string, runner: Runner): Git {
  const clonePath = (repo: string) => join(projects, repo);
  const worktreePath = (repo: string, branch: string) => join(projects, `${repo}-${branch}`);

  return {
    async ensureClone(repo) {
      if (existsSync(clonePath(repo))) {
        await runOrThrow(runner, ["git", "fetch", "origin"], clonePath(repo));
      } else {
        await runOrThrow(runner, ["gh", "repo", "clone", `kirhgoff/${repo}`, clonePath(repo)]);
      }
    },
    async addWorktree(repo, branch) {
      const path = worktreePath(repo, branch);
      await runOrThrow(runner, ["git", "worktree", "add", "-b", branch, path, "origin/HEAD"], clonePath(repo));
      return path;
    },
    async addPrWorktree(repo, pr) {
      const path = worktreePath(repo, `review-${pr}`);
      await runOrThrow(runner, ["git", "fetch", "origin", `pull/${pr}/head`], clonePath(repo));
      await runOrThrow(runner, ["git", "worktree", "add", "--detach", path, "FETCH_HEAD"], clonePath(repo));
      return path;
    },
    async removeWorktree(repo, branch) {
      await runner(["git", "worktree", "remove", "--force", worktreePath(repo, branch)], clonePath(repo));
      await runner(["git", "branch", "-D", branch], clonePath(repo));
    },
  };
}
