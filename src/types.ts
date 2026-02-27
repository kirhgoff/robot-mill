/**
 * Robot Mill - Core Types
 * 
 * Defines the TaskSource interface and related types for the pluggable task system.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TaskStatus = 
  | "todo"           // Available for robot to pick up
  | "in_progress"    // Robot is actively working on it
  | "needs_info"     // Robot asked questions, waiting for human
  | "in_review"      // Robot finished, human needs to review
  | "done"           // Completed and merged
  | "cancelled";     // Abandoned

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  humanBuddy: string;           // Human responsible for this task
  repository: string;           // GitHub repository URL or local path
  branch?: string;              // Optional branch name (if already created)
  priority?: number;            // Optional priority (lower = higher priority)
  labels?: string[];            // Optional labels/tags
}

export interface TaskDetails extends TaskSummary {
  description: string;          // Full task description
  assignee?: string;            // Current assignee (human name or "robot")
  plan?: string;                // Implementation plan (added by robot)
  questions?: string[];         // Clarifying questions (added by robot)
  notes: TaskNote[];            // Append-only notes/updates
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskNote {
  timestamp: Date;
  author: string;               // "robot" or human name
  type: "plan" | "question" | "answer" | "progress" | "review" | "general";
  content: string;
}

export interface AppendDetailsInput {
  type: TaskNote["type"];
  content: string;
  author?: string;              // Defaults to "robot"
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK SOURCE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TaskSource - Pluggable interface for task management systems
 * 
 * Implementations:
 * - MarkdownTaskSource: Local markdown files with frontmatter
 * - JiraTaskSource: Atlassian Jira integration
 * - (Future: Linear, GitHub Issues, Notion, etc.)
 */
export interface TaskSource {
  /** Unique identifier for this source type */
  readonly type: string;
  
  /** Human-readable name */
  readonly name: string;

  /**
   * Get list of available tasks for the robot to work on.
   * Only returns unassigned tasks in "todo" status.
   */
  getTaskList(): Promise<TaskSummary[]>;

  /**
   * Get full details of a specific task.
   */
  getTaskDetails(id: string): Promise<TaskDetails | null>;

  /**
   * Append information to a task (plan, question, progress note, etc.)
   */
  appendDetails(id: string, input: AppendDetailsInput): Promise<void>;

  /**
   * Start working on a task.
   * - Moves status to "in_progress"
   * - Assigns to "robot"
   */
  startWorking(id: string): Promise<void>;

  /**
   * Stop working because robot needs more information.
   * - Moves status back to "needs_info"  
   * - Assigns to humanBuddy
   * - Robot should have appended questions before calling this
   */
  stopWorkingNeedInfo(id: string): Promise<void>;

  /**
   * Stop working because implementation is ready for review.
   * - Moves status to "in_review"
   * - Assigns to humanBuddy
   * - Robot should have pushed changes and created PR before calling this
   */
  stopWorkingNeedReview(id: string): Promise<void>;

  /**
   * Mark task as complete (usually called by human after review).
   */
  markComplete(id: string): Promise<void>;

  /**
   * Create a new task (optional - not all sources may support this)
   */
  createTask?(input: Omit<TaskDetails, "id" | "notes" | "createdAt" | "updatedAt">): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT WORKTREE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorktreeInfo {
  path: string;                 // Absolute path to worktree
  branch: string;               // Branch checked out in this worktree
  commit: string;               // Current HEAD commit
  isMainWorktree: boolean;      // Is this the main repo directory?
  taskId?: string;              // Associated task ID (stored in .robot-task file)
}

export interface WorktreeManager {
  /**
   * List all worktrees in the repository
   */
  list(): Promise<WorktreeInfo[]>;

  /**
   * Create a new worktree for a task
   * @param taskId - Task identifier (used for directory naming)
   * @param branch - Branch to checkout (created if doesn't exist)
   * @param baseBranch - Base branch for new branches (default: main)
   */
  create(taskId: string, branch: string, baseBranch?: string): Promise<WorktreeInfo>;

  /**
   * Get worktree for a specific task
   */
  getForTask(taskId: string): Promise<WorktreeInfo | null>;

  /**
   * Remove a worktree (after task is complete)
   */
  remove(taskId: string): Promise<void>;

  /**
   * Get the main repository path
   */
  getMainRepoPath(): string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROBOT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface RobotConfig {
  /** Task source configuration */
  taskSource: {
    type: "markdown" | "jira";
    
    // Markdown-specific
    tasksDir?: string;
    
    // Jira-specific  
    jiraHost?: string;
    jiraProject?: string;
    jiraEmail?: string;
    jiraApiToken?: string;
    jiraRobotField?: string;    // Custom field to identify robot tasks
  };

  /** Git configuration */
  git: {
    mainBranch: string;         // Usually "main" or "master"
    worktreesDir: string;       // Where to create worktrees (default: ../.worktrees)
    branchPrefix: string;       // Prefix for robot branches (default: "robot/")
  };

  /** LLM configuration (for the robot agent) */
  llm: {
    provider: "anthropic" | "openai" | "google";
    model: string;
    apiKey?: string;            // Can also use env vars
  };

  /** Workflow settings */
  workflow: {
    autoPickTasks: boolean;     // Automatically pick next task when idle
    maxConcurrentTasks: number; // How many tasks to work on in parallel (using worktrees)
    requirePlanApproval: boolean; // Wait for human to approve plan before implementing
  };
}
