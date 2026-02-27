/**
 * Git Worktree Manager
 * 
 * Manages git worktrees for parallel task execution.
 * Each task gets its own worktree with its own branch, allowing
 * the robot to work on multiple tasks simultaneously.
 * 
 * Directory structure:
 * /project-repo/           <- Main repository
 * /project-repo/.worktrees/
 *   task-001/              <- Worktree for task-001
 *     .robot-task          <- Contains task ID
 *     ...project files...
 *   task-002/              <- Worktree for task-002
 *     ...
 */

import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join, resolve, dirname } from "path";
import { existsSync } from "fs";
import type { WorktreeInfo, WorktreeManager } from "../types.js";

const execAsync = promisify(exec);

export class GitWorktreeManager implements WorktreeManager {
  private mainRepoPath: string;
  private worktreesDir: string;
  private branchPrefix: string;

  constructor(
    mainRepoPath: string,
    options: {
      worktreesDir?: string;
      branchPrefix?: string;
    } = {}
  ) {
    this.mainRepoPath = resolve(mainRepoPath);
    this.worktreesDir = options.worktreesDir || join(this.mainRepoPath, ".worktrees");
    this.branchPrefix = options.branchPrefix || "robot/";
  }

  getMainRepoPath(): string {
    return this.mainRepoPath;
  }

  private async git(args: string, cwd?: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: cwd || this.mainRepoPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return stdout.trim();
  }

  private getWorktreePath(taskId: string): string {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    return join(this.worktreesDir, safeId);
  }

  private getBranchName(taskId: string): string {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    return `${this.branchPrefix}${safeId}`;
  }

  async list(): Promise<WorktreeInfo[]> {
    const output = await this.git("worktree list --porcelain");
    const worktrees: WorktreeInfo[] = [];

    const blocks = output.split("\n\n").filter(Boolean);

    for (const block of blocks) {
      const lines = block.split("\n");
      const info: Partial<WorktreeInfo> = {};

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          info.path = line.slice(9);
        } else if (line.startsWith("HEAD ")) {
          info.commit = line.slice(5);
        } else if (line.startsWith("branch ")) {
          info.branch = line.slice(7).replace("refs/heads/", "");
        } else if (line === "bare") {
          // Skip bare repos
          continue;
        }
      }

      if (info.path && info.commit) {
        info.isMainWorktree = info.path === this.mainRepoPath;

        // Check for .robot-task file
        const taskFile = join(info.path, ".robot-task");
        if (existsSync(taskFile)) {
          try {
            info.taskId = (await readFile(taskFile, "utf-8")).trim();
          } catch {
            // Ignore read errors
          }
        }

        worktrees.push(info as WorktreeInfo);
      }
    }

    return worktrees;
  }

  async create(
    taskId: string,
    branch?: string,
    baseBranch: string = "main"
  ): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = branch || this.getBranchName(taskId);

    // Ensure worktrees directory exists
    await mkdir(this.worktreesDir, { recursive: true });

    // Check if worktree already exists
    const existing = await this.getForTask(taskId);
    if (existing) {
      return existing;
    }

    // Check if branch exists
    let branchExists = false;
    try {
      await this.git(`rev-parse --verify ${branchName}`);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    // Fetch latest from remote
    try {
      await this.git("fetch origin");
    } catch {
      // Ignore fetch errors (might be offline or no remote)
    }

    // Create worktree
    if (branchExists) {
      // Checkout existing branch
      await this.git(`worktree add "${worktreePath}" ${branchName}`);
    } else {
      // Create new branch from base
      await this.git(`worktree add -b ${branchName} "${worktreePath}" origin/${baseBranch}`);
    }

    // Write .robot-task file
    await writeFile(join(worktreePath, ".robot-task"), taskId);

    // Add .robot-task to .gitignore if not already there
    const gitignorePath = join(worktreePath, ".gitignore");
    try {
      const gitignore = existsSync(gitignorePath)
        ? await readFile(gitignorePath, "utf-8")
        : "";
      if (!gitignore.includes(".robot-task")) {
        await writeFile(gitignorePath, gitignore + "\n.robot-task\n");
      }
    } catch {
      // Ignore gitignore errors
    }

    // Get commit info
    const commit = await this.git("rev-parse HEAD", worktreePath);

    return {
      path: worktreePath,
      branch: branchName,
      commit,
      isMainWorktree: false,
      taskId,
    };
  }

  async getForTask(taskId: string): Promise<WorktreeInfo | null> {
    const worktrees = await this.list();
    return worktrees.find((w) => w.taskId === taskId) || null;
  }

  async remove(taskId: string): Promise<void> {
    const worktree = await this.getForTask(taskId);
    if (!worktree) {
      return; // Already removed
    }

    // Remove worktree
    await this.git(`worktree remove "${worktree.path}" --force`);
  }

  /**
   * Remove all worktrees for completed/cancelled tasks
   */
  async prune(): Promise<void> {
    await this.git("worktree prune");
  }

  /**
   * Get the current branch in a worktree
   */
  async getCurrentBranch(worktreePath: string): Promise<string> {
    return this.git("rev-parse --abbrev-ref HEAD", worktreePath);
  }

  /**
   * Commit all changes in a worktree
   */
  async commit(worktreePath: string, message: string): Promise<string> {
    await this.git("add -A", worktreePath);
    await this.git(`commit -m "${message.replace(/"/g, '\\"')}"`, worktreePath);
    return this.git("rev-parse HEAD", worktreePath);
  }

  /**
   * Push changes to remote
   */
  async push(worktreePath: string, force: boolean = false): Promise<void> {
    const branch = await this.getCurrentBranch(worktreePath);
    const forceFlag = force ? "--force-with-lease" : "";
    await this.git(`push ${forceFlag} -u origin ${branch}`, worktreePath);
  }

  /**
   * Pull latest changes
   */
  async pull(worktreePath: string): Promise<void> {
    await this.git("pull --rebase", worktreePath);
  }

  /**
   * Get status of worktree
   */
  async getStatus(worktreePath: string): Promise<{
    clean: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
  }> {
    const status = await this.git("status --porcelain", worktreePath);
    const lines = status.split("\n").filter(Boolean);

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;

    for (const line of lines) {
      const index = line[0];
      const worktree = line[1];

      if (index === "?") {
        untracked++;
      } else {
        if (index !== " ") staged++;
        if (worktree !== " ") unstaged++;
      }
    }

    return {
      clean: lines.length === 0,
      staged,
      unstaged,
      untracked,
    };
  }
}
