/**
 * Robot Mill Extension for Pi
 * 
 * Provides tools for autonomous task processing:
 * - Task management (list, read, update status)
 * - Git worktree management (parallel task execution)
 * - Workflow orchestration
 * 
 * Usage: pi -e .pi/extensions/robot-mill.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@anthropic-ai/claude-code";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

interface RobotConfig {
  taskSource: "markdown" | "jira";
  tasksDir: string;
  reposDir: string;  // Directory to clone repositories into
  branchPrefix: string;
  defaultMainBranch: string;
  // Jira config (optional)
  jira?: {
    host: string;
    project: string;
    email: string;
  };
}

const DEFAULT_CONFIG: RobotConfig = {
  taskSource: "markdown",
  tasksDir: "./tasks",
  reposDir: "./repos",
  branchPrefix: "robot/",
  defaultMainBranch: "main",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type TaskStatus = "todo" | "in_progress" | "needs_info" | "in_review" | "done";

interface TaskNote {
  timestamp: string;
  author: string;
  type: "plan" | "question" | "answer" | "progress" | "review" | "general";
  content: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  humanBuddy: string;
  repository: string;
  branch?: string;
  assignee?: string;
  priority?: number;
  labels?: string[];
  plan?: string;
  questions?: string[];
  notes: TaskNote[];
  createdAt: string;
  updatedAt: string;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  taskId?: string;
  isMain: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface RobotState {
  config: RobotConfig;
  currentTaskId: string | null;
  currentWorktree: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const TaskListSchema = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("todo"),
    Type.Literal("in_progress"),
    Type.Literal("needs_info"),
    Type.Literal("in_review"),
    Type.Literal("done"),
    Type.Literal("all"),
  ])),
});

const TaskGetSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
});

const TaskAppendSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
  type: Type.Union([
    Type.Literal("plan"),
    Type.Literal("question"),
    Type.Literal("answer"),
    Type.Literal("progress"),
    Type.Literal("review"),
    Type.Literal("general"),
  ]),
  content: Type.String({ description: "Content to append" }),
});

const TaskStatusSchema = Type.Object({
  id: Type.String({ description: "Task ID" }),
  action: Type.Union([
    Type.Literal("start_working"),
    Type.Literal("need_info"),
    Type.Literal("need_review"),
    Type.Literal("complete"),
  ]),
});

const WorktreeListSchema = Type.Object({});

const WorktreeCreateSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to create worktree for" }),
  repository: Type.Optional(Type.String({ description: "Repository (GitHub: 'owner/repo', or local path). If not provided, reads from task." })),
  branch: Type.Optional(Type.String({ description: "Branch name (auto-generated if not provided)" })),
});

const WorktreeEnterSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to enter worktree for" }),
});

const GitOpsSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("status"),
    Type.Literal("commit"),
    Type.Literal("push"),
    Type.Literal("pull"),
  ]),
  message: Type.Optional(Type.String({ description: "Commit message (for commit operation)" })),
});

const WorkflowSchema = Type.Object({
  action: Type.Union([
    Type.Literal("next"),      // Pick next available task
    Type.Literal("status"),    // Show current workflow status
    Type.Literal("finish"),    // Finish current task (commit, push, submit for review)
  ]),
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN TASK SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; content: string } {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, content: markdown };

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") { endIndex = i; break; }
  }
  if (endIndex === -1) return { frontmatter: {}, content: markdown };

  const yamlLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join("\n").trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      let value: unknown = trimmed.slice(colonIndex + 1).trim();
      
      if ((value as string).startsWith("[") && (value as string).endsWith("]")) {
        value = (value as string).slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
      } else if (value === "null" || value === "~") {
        value = null;
      } else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      } else if (/^-?\d+(\.\d+)?$/.test(value as string)) {
        value = parseFloat(value as string);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content };
}

function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function parseNotes(content: string): { description: string; notes: TaskNote[] } {
  const notes: TaskNote[] = [];
  const notesMatch = content.match(/^## Notes\s*$/m);
  if (!notesMatch) return { description: content.trim(), notes: [] };

  const notesIndex = content.indexOf(notesMatch[0]);
  const description = content.slice(0, notesIndex).trim();
  const notesSection = content.slice(notesIndex + notesMatch[0].length).trim();

  const noteRegex = /^### (\S+) - (\w+) - (\w+)\s*$/gm;
  let match;
  const matches: { index: number; timestamp: string; author: string; type: string }[] = [];

  while ((match = noteRegex.exec(notesSection)) !== null) {
    matches.push({ index: match.index, timestamp: match[1], author: match[2], type: match[3] });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const endIndex = next ? next.index : notesSection.length;
    const headerEnd = notesSection.indexOf("\n", current.index);
    const noteContent = notesSection.slice(headerEnd + 1, endIndex).trim();
    notes.push({
      timestamp: current.timestamp,
      author: current.author,
      type: current.type as TaskNote["type"],
      content: noteContent,
    });
  }

  return { description, notes };
}

function serializeNotes(notes: TaskNote[]): string {
  if (notes.length === 0) return "";
  const lines = ["", "## Notes", ""];
  for (const note of notes) {
    lines.push(`### ${note.timestamp} - ${note.author} - ${note.type}`);
    lines.push("");
    lines.push(note.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════════════

export default function robotMill(pi: ExtensionAPI) {
  let state: RobotState = {
    config: { ...DEFAULT_CONFIG },
    currentTaskId: null,
    currentWorktree: null,
  };

  // Load config on startup
  const loadConfig = async () => {
    const configPath = join(process.cwd(), ".robot-mill.json");
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      state.config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Source Helpers (Markdown)
  // ─────────────────────────────────────────────────────────────────────────────

  const getTasksDir = () => resolve(process.cwd(), state.config.tasksDir);

  const readTask = async (id: string): Promise<Task | null> => {
    const filePath = join(getTasksDir(), `${id}.md`);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, "utf-8");
    const { frontmatter, content: body } = parseFrontmatter(content);
    const { description, notes } = parseNotes(body);

    return {
      id: frontmatter.id as string || id,
      title: frontmatter.title as string || "Untitled",
      description,
      status: frontmatter.status as TaskStatus || "todo",
      humanBuddy: frontmatter.humanBuddy as string || "unknown",
      repository: frontmatter.repository as string || "",
      branch: frontmatter.branch as string | undefined,
      assignee: frontmatter.assignee as string | undefined,
      priority: frontmatter.priority as number | undefined,
      labels: frontmatter.labels as string[] | undefined,
      notes,
      createdAt: frontmatter.createdAt as string || new Date().toISOString(),
      updatedAt: frontmatter.updatedAt as string || new Date().toISOString(),
    };
  };

  const writeTask = async (task: Task): Promise<void> => {
    await mkdir(getTasksDir(), { recursive: true });
    const filePath = join(getTasksDir(), `${task.id}.md`);

    const frontmatter = serializeFrontmatter({
      id: task.id,
      title: task.title,
      status: task.status,
      humanBuddy: task.humanBuddy,
      repository: task.repository,
      branch: task.branch || null,
      assignee: task.assignee || null,
      priority: task.priority || null,
      labels: task.labels || [],
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString(),
    });

    const description = task.description ? `\n## Description\n\n${task.description}` : "";
    const notes = serializeNotes(task.notes);
    await writeFile(filePath, `${frontmatter}\n${description}\n${notes}`, "utf-8");
  };

  const listTasks = async (statusFilter?: string): Promise<Task[]> => {
    const tasksDir = getTasksDir();
    if (!existsSync(tasksDir)) return [];

    const { readdir } = await import("fs/promises");
    const files = await readdir(tasksDir);
    const tasks: Task[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      const task = await readTask(id);
      if (task) {
        if (!statusFilter || statusFilter === "all" || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    }

    return tasks.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Repository Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  const git = async (args: string, cwd?: string): Promise<string> => {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: cwd || process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  };

  const getReposDir = () => resolve(process.cwd(), state.config.reposDir);

  /**
   * Parse a repository reference and return clone URL and local path
   * Supports:
   * - GitHub: "owner/repo" or "github.com/owner/repo"
   * - Full URL: "https://github.com/owner/repo.git"
   * - Local path: "/path/to/repo" (returns as-is)
   */
  const parseRepository = (repository: string): { cloneUrl: string; localPath: string; repoName: string } | null => {
    // Local path - return null to indicate no clone needed
    if (repository.startsWith("/") || repository.startsWith("./") || repository.startsWith("~")) {
      return null;
    }

    // Full git URL
    if (repository.startsWith("https://") || repository.startsWith("git@")) {
      const match = repository.match(/([^\/]+)\/([^\/]+?)(\.git)?$/);
      if (match) {
        const repoName = match[2];
        const localPath = join(getReposDir(), repoName);
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
      const localPath = join(getReposDir(), repo);
      return { cloneUrl, localPath, repoName: repo };
    }

    return null;
  };

  /**
   * Ensure a repository is cloned and ready
   * Returns the local path to the repository
   */
  const ensureRepository = async (repository: string): Promise<string> => {
    const parsed = parseRepository(repository);
    
    // Local path - verify it exists
    if (!parsed) {
      if (!existsSync(repository)) {
        throw new Error(`Local repository not found: ${repository}`);
      }
      return repository;
    }

    const { cloneUrl, localPath, repoName } = parsed;

    // Already cloned?
    if (existsSync(join(localPath, ".git"))) {
      // Fetch latest
      try {
        await git("fetch origin", localPath);
      } catch { /* ignore fetch errors */ }
      return localPath;
    }

    // Clone the repository
    await mkdir(getReposDir(), { recursive: true });
    await git(`clone ${cloneUrl} "${localPath}"`);
    
    return localPath;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Git Worktree Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  const listWorktreesForRepo = async (repoPath: string): Promise<WorktreeInfo[]> => {
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
  };

  /**
   * List all worktrees across all cloned repositories
   */
  const listWorktrees = async (): Promise<WorktreeInfo[]> => {
    const reposDir = getReposDir();
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
      } catch { /* ignore errors */ }
    }

    return allWorktrees;
  };

  const createWorktree = async (taskId: string, repository: string, branch?: string): Promise<WorktreeInfo> => {
    // Ensure repository is cloned
    const repoPath = await ensureRepository(repository);

    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const worktreePath = join(repoPath, ".worktrees", safeId);
    const branchName = branch || `${state.config.branchPrefix}${safeId}`;

    await mkdir(join(repoPath, ".worktrees"), { recursive: true });

    // Check if worktree already exists
    const existing = await listWorktreesForRepo(repoPath);
    const found = existing.find(w => w.taskId === taskId);
    if (found) return found;

    // Detect main branch
    let mainBranch = state.config.defaultMainBranch;
    try {
      // Try to get default branch from remote
      const remoteInfo = await git("remote show origin", repoPath);
      const match = remoteInfo.match(/HEAD branch:\s*(\S+)/);
      if (match) mainBranch = match[1];
    } catch { /* use default */ }

    // Check if branch exists
    let branchExists = false;
    try {
      await git(`rev-parse --verify ${branchName}`, repoPath);
      branchExists = true;
    } catch { branchExists = false; }

    // Fetch latest
    try { await git("fetch origin", repoPath); } catch { /* ignore */ }

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
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    await loadConfig();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: task_list
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "task_list",
    description: "List available tasks. By default shows only 'todo' tasks (available for robot to pick up).",
    parameters: TaskListSchema,

    async execute(_id, params) {
      const tasks = await listTasks(params.status || "todo");

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: `No tasks found with status: ${params.status || "todo"}` }],
          details: { tasks: [] },
        };
      }

      const summary = tasks.map(t => 
        `[${t.status}] ${t.id}: ${t.title} (buddy: ${t.humanBuddy}, repo: ${t.repository})`
      ).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { tasks },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: task_get
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "task_get",
    description: "Get full details of a specific task including description, plan, questions, and all notes.",
    parameters: TaskGetSchema,

    async execute(_id, params) {
      const task = await readTask(params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      const output = [
        `# ${task.title}`,
        ``,
        `- **ID:** ${task.id}`,
        `- **Status:** ${task.status}`,
        `- **Human Buddy:** ${task.humanBuddy}`,
        `- **Repository:** ${task.repository}`,
        `- **Branch:** ${task.branch || "(not set)"}`,
        `- **Assignee:** ${task.assignee || "(unassigned)"}`,
        ``,
        `## Description`,
        ``,
        task.description,
        ``,
        `## Notes (${task.notes.length})`,
        ...task.notes.map(n => `\n### ${n.timestamp} - ${n.author} - ${n.type}\n\n${n.content}`),
      ].join("\n");

      return {
        content: [{ type: "text", text: output }],
        details: { task },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: task_append
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "task_append",
    description: "Append a note to a task. Use type='plan' for implementation plans, 'question' for clarifying questions, 'progress' for status updates.",
    parameters: TaskAppendSchema,

    async execute(_id, params) {
      const task = await readTask(params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      task.notes.push({
        timestamp: new Date().toISOString(),
        author: "robot",
        type: params.type,
        content: params.content,
      });

      if (params.type === "plan") task.plan = params.content;

      await writeTask(task);

      return {
        content: [{ type: "text", text: `✓ Appended ${params.type} note to ${task.id}` }],
        details: { task },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: task_status
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "task_status",
    description: `Change task status:
- start_working: Begin work (status → in_progress, assignee → robot)
- need_info: Need clarification (status → needs_info, assignee → humanBuddy)
- need_review: Ready for review (status → in_review, assignee → humanBuddy)
- complete: Mark done (status → done)`,
    parameters: TaskStatusSchema,

    async execute(_id, params) {
      const task = await readTask(params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          isError: true,
        };
      }

      const oldStatus = task.status;

      switch (params.action) {
        case "start_working":
          task.status = "in_progress";
          task.assignee = "robot";
          state.currentTaskId = task.id;
          break;
        case "need_info":
          task.status = "needs_info";
          task.assignee = task.humanBuddy;
          state.currentTaskId = null;
          break;
        case "need_review":
          task.status = "in_review";
          task.assignee = task.humanBuddy;
          state.currentTaskId = null;
          break;
        case "complete":
          task.status = "done";
          task.assignee = undefined;
          state.currentTaskId = null;
          break;
      }

      await writeTask(task);

      return {
        content: [{ type: "text", text: `✓ Task ${task.id}: ${oldStatus} → ${task.status}` }],
        details: { task, oldStatus, newStatus: task.status },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: worktree_list
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "worktree_list",
    description: "List all git worktrees. Each worktree can be working on a separate task in parallel.",
    parameters: WorktreeListSchema,

    async execute() {
      const worktrees = await listWorktrees();

      if (worktrees.length === 0) {
        return {
          content: [{ type: "text", text: "No worktrees found" }],
          details: { worktrees: [] },
        };
      }

      const summary = worktrees.map(w => 
        `${w.isMain ? "★" : "○"} ${w.branch} → ${w.path}${w.taskId ? ` (task: ${w.taskId})` : ""}`
      ).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { worktrees },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: worktree_create
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "worktree_create",
    description: "Create a new git worktree for a task. Clones the repository if needed (supports GitHub 'owner/repo' format). Each task gets its own directory with its own branch.",
    parameters: WorktreeCreateSchema,

    async execute(_id, params) {
      try {
        // Get repository from params or task
        let repository = params.repository;
        const task = await readTask(params.taskId);
        
        if (!repository && task) {
          repository = task.repository;
        }

        if (!repository) {
          return {
            content: [{ type: "text", text: `Error: No repository specified and task ${params.taskId} has no repository set` }],
            isError: true,
          };
        }

        const worktree = await createWorktree(params.taskId, repository, params.branch);

        // Update task with branch name
        if (task && !task.branch) {
          task.branch = worktree.branch;
          await writeTask(task);
        }

        state.currentWorktree = worktree.path;

        return {
          content: [{ type: "text", text: `✓ Created worktree for ${params.taskId}\n  Repository: ${repository}\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}` }],
          details: { worktree },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error creating worktree: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: worktree_enter
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "worktree_enter",
    description: "Set the current working directory to a task's worktree. All subsequent file operations will be in this worktree.",
    parameters: WorktreeEnterSchema,

    async execute(_id, params) {
      const worktrees = await listWorktrees();
      const worktree = worktrees.find(w => w.taskId === params.taskId);

      if (!worktree) {
        return {
          content: [{ type: "text", text: `No worktree found for task: ${params.taskId}. Create one first with worktree_create.` }],
          isError: true,
        };
      }

      state.currentWorktree = worktree.path;
      process.chdir(worktree.path);

      return {
        content: [{ type: "text", text: `✓ Entered worktree for ${params.taskId}\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}` }],
        details: { worktree },
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: git_ops
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_ops",
    description: "Git operations in current worktree: status, commit, push, pull",
    parameters: GitOpsSchema,

    async execute(_id, params) {
      const cwd = state.currentWorktree || process.cwd();

      try {
        switch (params.operation) {
          case "status": {
            const status = await git("status --porcelain", cwd);
            const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
            return {
              content: [{ type: "text", text: `Branch: ${branch}\n\n${status || "(clean)"}` }],
            };
          }
          case "commit": {
            if (!params.message) {
              return { content: [{ type: "text", text: "Error: commit message required" }], isError: true };
            }
            await git("add -A", cwd);
            await git(`commit -m "${params.message.replace(/"/g, '\\"')}"`, cwd);
            const hash = await git("rev-parse --short HEAD", cwd);
            return { content: [{ type: "text", text: `✓ Committed: ${hash}` }] };
          }
          case "push": {
            const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
            await git(`push -u origin ${branch}`, cwd);
            return { content: [{ type: "text", text: `✓ Pushed to origin/${branch}` }] };
          }
          case "pull": {
            await git("pull --rebase", cwd);
            return { content: [{ type: "text", text: `✓ Pulled latest changes` }] };
          }
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Git error: ${err}` }], isError: true };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TOOL: workflow
  // ─────────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "workflow",
    description: `High-level workflow commands:
- next: Pick up the next available task, create worktree, start working
- status: Show current workflow status
- finish: Commit changes, push, submit for review`,
    parameters: WorkflowSchema,

    async execute(_id, params) {
      switch (params.action) {
        case "next": {
          // Find available task
          const tasks = await listTasks("todo");
          if (tasks.length === 0) {
            return { content: [{ type: "text", text: "No available tasks. All caught up! 🎉" }] };
          }

          const task = tasks[0];

          if (!task.repository) {
            return { 
              content: [{ type: "text", text: `Error: Task ${task.id} has no repository specified` }],
              isError: true,
            };
          }

          // Start working
          task.status = "in_progress";
          task.assignee = "robot";
          await writeTask(task);
          state.currentTaskId = task.id;

          // Create worktree (this will clone the repo if needed)
          const worktree = await createWorktree(task.id, task.repository);
          task.branch = worktree.branch;
          await writeTask(task);

          // Enter worktree
          state.currentWorktree = worktree.path;
          process.chdir(worktree.path);

          return {
            content: [{ type: "text", text: `
🤖 Starting task: ${task.title}

**Task ID:** ${task.id}
**Repository:** ${task.repository}
**Worktree:** ${worktree.path}
**Branch:** ${worktree.branch}

## Description

${task.description}

---

Next steps:
1. Read and understand the task
2. Use \`task_append\` with type="plan" to record your implementation plan
3. Implement the changes
4. Use \`workflow finish\` when done
` }],
            details: { task, worktree },
          };
        }

        case "status": {
          const worktrees = await listWorktrees();
          const activeTasks = await listTasks("in_progress");

          return {
            content: [{ type: "text", text: `
## Workflow Status

**Current Task:** ${state.currentTaskId || "(none)"}
**Current Worktree:** ${state.currentWorktree || "(main)"}

**Active Tasks:** ${activeTasks.length}
${activeTasks.map(t => `  - ${t.id}: ${t.title}`).join("\n")}

**Worktrees:** ${worktrees.length}
${worktrees.map(w => `  - ${w.branch}${w.taskId ? ` (${w.taskId})` : ""}`).join("\n")}
` }],
          };
        }

        case "finish": {
          if (!state.currentTaskId) {
            return { content: [{ type: "text", text: "No active task. Use `workflow next` to pick one up." }], isError: true };
          }

          const task = await readTask(state.currentTaskId);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${state.currentTaskId}` }], isError: true };
          }

          const cwd = state.currentWorktree || process.cwd();

          // Check for changes
          const status = await git("status --porcelain", cwd);
          if (status) {
            // Commit changes
            await git("add -A", cwd);
            await git(`commit -m "feat(${task.id}): ${task.title}"`, cwd);
          }

          // Push
          const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
          try {
            await git(`push -u origin ${branch}`, cwd);
          } catch {
            // Might fail if no remote, that's ok
          }

          // Update task status
          task.status = "in_review";
          task.assignee = task.humanBuddy;
          task.notes.push({
            timestamp: new Date().toISOString(),
            author: "robot",
            type: "progress",
            content: `Implementation complete. Branch: ${branch}`,
          });
          await writeTask(task);

          state.currentTaskId = null;

          return {
            content: [{ type: "text", text: `
✓ Task ${task.id} submitted for review!

**Branch:** ${branch}
**Assigned to:** ${task.humanBuddy}

The task is now in "in_review" status. Your human buddy will review the changes.

Use \`workflow next\` to pick up another task.
` }],
          };
        }
      }
    },
  });
}
