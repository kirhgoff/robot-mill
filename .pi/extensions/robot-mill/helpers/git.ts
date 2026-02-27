/**
 * Robot Mill — Git Operations Helpers
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import type { WorktreeInfo, RobotState } from "../types.ts";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════════════════════════
// SLUG GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a title to a URL/branch-safe slug
 * "Remove User Service Singleton" → "remove-user-service-singleton"
 */
export function slugify(text: string, maxLength: number = 40): string {
  return text
    .toLowerCase()
    .trim()
    // Replace common separators with hyphens
    .replace(/[\s_/\\]+/g, "-")
    // Remove non-alphanumeric characters (except hyphens)
    .replace(/[^a-z0-9-]/g, "")
    // Collapse multiple hyphens
    .replace(/-+/g, "-")
    // Remove leading/trailing hyphens
    .replace(/^-|-$/g, "")
    // Truncate to max length, but don't cut in the middle of a word
    .slice(0, maxLength)
    .replace(/-$/, ""); // Remove trailing hyphen after truncation
}

/**
 * Generate a branch name from task ID and title
 * "jora-002" + "Remove User Service" → "robot/jora-002-remove-user-service"
 */
export function generateBranchName(
  taskId: string,
  title: string | undefined,
  prefix: string
): string {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
  
  if (!title) {
    return `${prefix}${safeId}`;
  }
  
  const slug = slugify(title, 40);
  
  // Avoid duplication if task ID is already in the title slug
  if (slug.startsWith(safeId.toLowerCase())) {
    return `${prefix}${slug}`;
  }
  
  return `${prefix}${safeId}-${slug}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT COMMAND WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

export async function git(args: string, cwd?: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, {
    cwd: cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function gitWithStderr(args: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(`git ${args}`, {
    cwd: cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPOSITORY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function getReposDir(state: RobotState, cwd: string): string {
  return resolve(cwd, state.config.reposDir);
}

/**
 * Parse a repository reference and return clone URL and local path
 * Supports:
 * - GitHub: "owner/repo" or "github.com/owner/repo"
 * - Full URL: "https://github.com/owner/repo.git"
 * - Local path: "/path/to/repo" (returns null)
 */
export function parseRepository(
  repository: string,
  reposDir: string
): { cloneUrl: string; localPath: string; repoName: string } | null {
  // Local path - return null to indicate no clone needed
  if (repository.startsWith("/") || repository.startsWith("./") || repository.startsWith("~")) {
    return null;
  }

  // Full git URL
  if (repository.startsWith("https://") || repository.startsWith("git@")) {
    const match = repository.match(/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (match) {
      const repoName = match[2];
      const localPath = join(reposDir, repoName);
      return { cloneUrl: repository, localPath, repoName };
    }
    return null;
  }

  // GitHub shorthand: "owner/repo" or "github.com/owner/repo"
  const cleaned = repository.replace(/^github\.com\//, "");
  const parts = cleaned.split("/");
  if (parts.length === 2) {
    const [owner, repo] = parts;
    const cloneUrl = `git@github.com:${owner}/${repo}.git`;
    const localPath = join(reposDir, repo);
    return { cloneUrl, localPath, repoName: repo };
  }

  return null;
}

/**
 * Ensure a repository is cloned and ready
 * Returns the local path to the repository
 */
export async function ensureRepository(
  repository: string,
  state: RobotState,
  cwd: string
): Promise<string> {
  const reposDir = getReposDir(state, cwd);
  const parsed = parseRepository(repository, reposDir);

  // Local path - verify it exists
  if (!parsed) {
    if (!existsSync(repository)) {
      throw new Error(`Local repository not found: ${repository}`);
    }
    return repository;
  }

  const { cloneUrl, localPath } = parsed;

  // Already cloned?
  if (existsSync(join(localPath, ".git"))) {
    // Fetch latest
    try {
      await git("fetch origin", localPath);
    } catch {
      /* ignore fetch errors */
    }
    return localPath;
  }

  // Clone the repository
  await mkdir(reposDir, { recursive: true });
  await git(`clone ${cloneUrl} "${localPath}"`);

  return localPath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKTREE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export async function listWorktreesForRepo(repoPath: string): Promise<WorktreeInfo[]> {
  const output = await git("worktree list --porcelain", repoPath);
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const info: Partial<WorktreeInfo> = { isMain: false };

    for (const line of lines) {
      if (line.startsWith("worktree ")) info.path = line.slice(9);
      else if (line.startsWith("HEAD ")) info.commit = line.slice(5);
      else if (line.startsWith("branch ")) info.branch = line.slice(7).replace("refs/heads/", "");
    }

    if (info.path && info.commit) {
      info.isMain = info.path === repoPath;
      const taskFile = join(info.path, ".robot-task");
      if (existsSync(taskFile)) {
        info.taskId = (await readFile(taskFile, "utf-8")).trim();
      }
      worktrees.push(info as WorktreeInfo);
    }
  }

  return worktrees;
}

/**
 * List all worktrees across all cloned repositories
 */
export async function listAllWorktrees(state: RobotState, cwd: string): Promise<WorktreeInfo[]> {
  const reposDir = getReposDir(state, cwd);
  if (!existsSync(reposDir)) return [];

  const { readdir } = await import("fs/promises");
  const entries = await readdir(reposDir, { withFileTypes: true });
  const allWorktrees: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(reposDir, entry.name);
    if (!existsSync(join(repoPath, ".git"))) continue;

    try {
      const worktrees = await listWorktreesForRepo(repoPath);
      allWorktrees.push(...worktrees);
    } catch {
      /* ignore errors */
    }
  }

  return allWorktrees;
}

export async function createWorktree(
  taskId: string,
  repository: string,
  state: RobotState,
  cwd: string,
  branch?: string,
  taskTitle?: string
): Promise<WorktreeInfo> {
  // Ensure repository is cloned
  const repoPath = await ensureRepository(repository, state, cwd);

  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const worktreePath = join(repoPath, ".worktrees", safeId);
  
  // Generate branch name with meaningful slug from title
  const branchName = branch || generateBranchName(taskId, taskTitle, state.config.branchPrefix);

  await mkdir(join(repoPath, ".worktrees"), { recursive: true });

  // Check if worktree already exists
  const existing = await listWorktreesForRepo(repoPath);
  const found = existing.find((w) => w.taskId === taskId);
  if (found) return found;

  // Detect main branch
  let mainBranch = state.config.defaultMainBranch;
  try {
    const remoteInfo = await git("remote show origin", repoPath);
    const match = remoteInfo.match(/HEAD branch:\s*(\S+)/);
    if (match) mainBranch = match[1];
  } catch {
    /* use default */
  }

  // Check if branch exists
  let branchExists = false;
  try {
    await git(`rev-parse --verify ${branchName}`, repoPath);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // Fetch latest
  try {
    await git("fetch origin", repoPath);
  } catch {
    /* ignore */
  }

  // Create worktree
  if (branchExists) {
    await git(`worktree add "${worktreePath}" ${branchName}`, repoPath);
  } else {
    await git(`worktree add -b ${branchName} "${worktreePath}" origin/${mainBranch}`, repoPath);
  }

  // Write task marker
  await writeFile(join(worktreePath, ".robot-task"), taskId);

  const commit = await git("rev-parse HEAD", worktreePath);
  return { path: worktreePath, branch: branchName, commit, taskId, isMain: false };
}
