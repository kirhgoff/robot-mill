/**
 * GitManager — manages the bare clone and per-variation worktrees.
 *
 * Layout on disk (inside the bind-mounted target-data directory):
 *
 *   <dataDir>/
 *     .source.git/          ← bare clone of the source repo
 *     worktrees/
 *       dark-hero-section/  ← git worktree (checked-out files)
 *       bold-cta/
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitManager {
	private readonly dataDir: string;
	private readonly bareDir: string;
	private readonly worktreesDir: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.bareDir = join(dataDir, ".source.git");
		this.worktreesDir = join(dataDir, "worktrees");

		mkdirSync(this.worktreesDir, { recursive: true });
	}

	/** Ensure the bare repo exists and is up to date. */
	async ensureBareClone(repoUrl: string): Promise<void> {
		if (!existsSync(this.bareDir)) {
			await this.git(["clone", "--bare", repoUrl, this.bareDir], this.dataDir);
		}
		// Ensure the bare clone has a sane fetch refspec. `git clone --bare` does
		// NOT add one by default, so `git fetch` would only refresh HEAD and
		// silently leave `main`/other branch refs pointing at stale commits.
		await this.ensureFetchRefspec();
		await this.fetchLatest();
	}

	/** Fetch latest changes from origin for the existing bare clone. */
	async fetchLatest(): Promise<void> {
		if (!existsSync(this.bareDir)) return;
		// Explicit refspec guarantees branch refs get updated even when the
		// bare repo's config is missing the usual `fetch = +refs/heads/*:...`.
		// We deliberately do NOT pass --prune here: local `variation/*` branches
		// are created for worktrees and must survive fetches even though they
		// don't exist on origin.
		await this.git(
			["fetch", "origin", "+refs/heads/*:refs/heads/*", "--tags"],
			this.bareDir,
		);
		// Re-point HEAD to origin's current default branch in case it changed
		await this.syncDefaultBranch();
	}

	/** Make sure `remote.origin.fetch` is set so regular fetches update branches. */
	private async ensureFetchRefspec(): Promise<void> {
		try {
			const { stdout } = await this.git(
				["config", "--get-all", "remote.origin.fetch"],
				this.bareDir,
			);
			if (stdout.includes("refs/heads/*:refs/heads/*")) return;
		} catch {
			// No refspec configured — fall through and add one.
		}
		await this.git(
			[
				"config",
				"--add",
				"remote.origin.fetch",
				"+refs/heads/*:refs/heads/*",
			],
			this.bareDir,
		);
	}

	/** List branches that exist in the bare repo (excluding variation/* branches). */
	async listBranches(): Promise<string[]> {
		if (!existsSync(this.bareDir)) return [];
		const { stdout } = await this.git(
			["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
			this.bareDir,
		);
		return stdout
			.trim()
			.split("\n")
			.map((b) => b.trim())
			.filter(
				(b) =>
					b.length > 0 &&
					!b.startsWith("variation/") &&
					!b.startsWith("baseline/"),
			);
	}

	/** Create a new worktree with a fresh branch based on the given base branch (or default). */
	async createWorktree(slug: string, baseBranch?: string): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);

		if (existsSync(worktreePath)) {
			throw new Error(`Worktree already exists: ${slug}`);
		}

		// Determine base branch to branch from
		const base = baseBranch?.trim() || (await this.getDefaultBranch());

		// Create worktree with a new branch from the base branch
		const branchName = `variation/${slug}`;
		await this.git(
			["worktree", "add", "-b", branchName, worktreePath, base],
			this.bareDir,
		);

		return worktreePath;
	}

	/**
	 * Create (if missing) the baseline "main" worktree that tracks the source
	 * repo's default branch. We branch it off under a dedicated branch name
	 * (`baseline/<slug>`) because a git branch can only be checked out in one
	 * worktree at a time — the actual `main` branch is used as the base for
	 * new variations and must stay available in the bare repo.
	 */
	async ensureBaselineWorktree(slug: string): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);
		const defaultBranch = await this.getDefaultBranch();
		const branchName = `baseline/${slug}`;

		if (existsSync(worktreePath)) {
			return worktreePath;
		}

		// Create worktree with a dedicated baseline branch, starting at the
		// current tip of the default branch.
		await this.git(
			["worktree", "add", "-b", branchName, worktreePath, defaultBranch],
			this.bareDir,
		);

		return worktreePath;
	}

	/**
	 * Hard-refresh the baseline worktree to match the latest default branch
	 * from origin. Fetches, resets to the default branch tip, and removes all
	 * untracked / ignored files. Destructive — intended for the "main"
	 * baseline variation only.
	 */
	async refreshBaselineWorktree(slug: string): Promise<void> {
		const worktreePath = join(this.worktreesDir, slug);
		if (!existsSync(worktreePath)) {
			throw new Error(`Baseline worktree missing: ${slug}`);
		}

		// Pull latest refs into the bare clone
		await this.fetchLatest();
		const defaultBranch = await this.getDefaultBranch();

		// Hard-reset the worktree to the default branch tip and wipe everything
		// that isn't tracked (including ignored files like node_modules/dist).
		await this.git(["reset", "--hard", defaultBranch], worktreePath);
		await this.git(["clean", "-fdx"], worktreePath);
	}

	/** Remove a worktree and its branch. */
	async removeWorktree(slug: string): Promise<void> {
		const worktreePath = join(this.worktreesDir, slug);

		if (existsSync(worktreePath)) {
			await this.git(
				["worktree", "remove", "--force", worktreePath],
				this.bareDir,
			);
		}

		// Also delete the branch
		const branchName = `variation/${slug}`;
		try {
			await this.git(["branch", "-D", branchName], this.bareDir);
		} catch {
			// Branch may already be gone
		}
	}

	/** Get the git diff for a worktree compared to its base. */
	async getDiff(slug: string): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);
		const defaultBranch = await this.getDefaultBranch();

		const { stdout } = await this.git(
			["diff", defaultBranch, "--", "."],
			worktreePath,
		);
		return stdout;
	}

	/** Get the diff --stat summary. */
	async getDiffStat(slug: string): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);
		const defaultBranch = await this.getDefaultBranch();

		const { stdout } = await this.git(
			["diff", "--stat", defaultBranch, "--", "."],
			worktreePath,
		);
		return stdout;
	}

	/** Get the git log for a worktree. */
	async getLog(slug: string, maxCount = 50): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);
		const defaultBranch = await this.getDefaultBranch();

		const { stdout } = await this.git(
			[
				"log",
				`${defaultBranch}..HEAD`,
				`--max-count=${maxCount}`,
				"--oneline",
				"--decorate",
			],
			worktreePath,
		);
		return stdout;
	}

	/** Get changed files list for a worktree. */
	async getChangedFiles(slug: string): Promise<string[]> {
		const worktreePath = join(this.worktreesDir, slug);
		const defaultBranch = await this.getDefaultBranch();

		const { stdout } = await this.git(
			["diff", "--name-only", defaultBranch, "--", "."],
			worktreePath,
		);
		return stdout
			.trim()
			.split("\n")
			.filter((f) => f.length > 0);
	}

	/** Push the variation branch to origin and create a GitHub pull request.
	 *  Returns the PR URL. Requires `gh` CLI to be authenticated.
	 */
	async createPullRequest(slug: string, title: string): Promise<string> {
		const worktreePath = join(this.worktreesDir, slug);
		const branchName = `variation/${slug}`;

		// Push branch to origin from the bare repo
		await this.git(["push", "origin", branchName], this.bareDir);

		// Create the PR from the worktree context (gh needs a working tree)
		const { stdout } = await execFileAsync(
			"gh",
			[
				"pr",
				"create",
				"--title",
				title,
				"--body",
				"Created by Vary",
				"--head",
				branchName,
			],
			{ cwd: worktreePath },
		);

		return stdout.trim();
	}

	/** Get the worktree path for a slug. */
	getWorktreePath(slug: string): string {
		return join(this.worktreesDir, slug);
	}

	/** Get all worktree directories that exist on disk. */
	listWorktreeDirs(): string[] {
		try {
			return readdirSync(this.worktreesDir);
		} catch {
			return [];
		}
	}

	private async getDefaultBranch(): Promise<string> {
		try {
			const { stdout } = await this.git(
				["symbolic-ref", "--short", "HEAD"],
				this.bareDir,
			);
			return stdout.trim() || "main";
		} catch {
			return "main";
		}
	}

	/** Ask origin for its default branch and update the bare repo's HEAD to match. */
	private async syncDefaultBranch(): Promise<void> {
		try {
			// `remote set-head origin -a` auto-detects origin/HEAD
			await this.git(["remote", "set-head", "origin", "-a"], this.bareDir);
		} catch {
			// Non-fatal — fall back to existing HEAD
		}
	}

	private git(
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; stderr: string }> {
		return execFileAsync("git", args, {
			cwd,
			maxBuffer: 10 * 1024 * 1024, // 10 MB for large diffs
		});
	}
}
