import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function repoNameFromRemote(repo: string) {
  const raw = basename(repo).replace(/\.git$/, '');
  const s = slug(raw);
  return s.length > 0 ? s : 'repo';
}

function run(cmd: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { cwd, shell: true, stdio: 'inherit', env: process.env });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Failed: ${cmd}`))));
  });
}

export async function prepareRepo(args: {
  taskId: string;
  repo: string;
  preferredBranch?: string;
  workspacesDir: string;
}): Promise<{ repoDir: string; branch: string }> {
  const reposDir = join(args.workspacesDir, 'repos');
  const worktreesDir = join(args.workspacesDir, 'worktrees');
  await mkdir(reposDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });

  const repoSlug = repoNameFromRemote(args.repo);
  const repoDir = join(reposDir, repoSlug);

  try {
    await run('git rev-parse --is-inside-work-tree', repoDir);
    await run('git fetch --all --prune', repoDir);
  } catch {
    await run(`git clone ${args.repo} ${repoDir}`);
  }

  const branch = args.preferredBranch ?? `robot/${slug(args.taskId)}`;
  const wtDir = join(worktreesDir, args.taskId);

  try {
    await run(`git worktree add -B ${branch} ${wtDir}`, repoDir);
  } catch {
    await run(`git worktree add ${wtDir} ${branch}`, repoDir);
  }

  return { repoDir: wtDir, branch };
}
