/**
 * Robot Mill — Shared Types
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface RobotConfig {
  taskSource: "markdown" | "jira";
  tasksDir: string;
  reposDir: string;
  branchPrefix: string;
  defaultMainBranch: string;
  jira?: {
    host: string;
    project: string;
    email: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

export type TaskStatus = "todo" | "in_progress" | "needs_info" | "in_review" | "done";

export interface TaskNote {
  timestamp: string;
  author: string;
  type: "plan" | "question" | "answer" | "progress" | "review" | "general";
  content: string;
}

export interface Task {
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

// ═══════════════════════════════════════════════════════════════════════════════
// GIT WORKTREES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  taskId?: string;
  isMain: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENTS & CHAINS
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentDef {
  name: string;
  description: string;
  tools: string;
  systemPrompt: string;
}

export interface ChainStep {
  agent: string;
  prompt: string;
}

export interface ChainDef {
  name: string;
  description: string;
  steps: ChainStep[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION STATE (for TUI widget)
// ═══════════════════════════════════════════════════════════════════════════════

export type ExecutionStatus = "idle" | "running" | "done" | "error";

export interface StepState {
  agent: string;
  status: "pending" | "running" | "done" | "error";
  startTime: number;
  elapsed: number;
  lastOutput: string;
  // Full output for recording in task notes
  fullOutput: string;
  // Last N lines for widget display
  recentLines: string[];
}

export interface ExecutionState {
  taskId: string;
  taskTitle: string;
  chainName: string;
  steps: StepState[];
  currentStep: number;
  startTime: number;
  status: ExecutionStatus;
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLICATION STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface RobotState {
  config: RobotConfig;
  currentTaskId: string | null;
  currentWorktree: string | null;
  execution: ExecutionState;
  // Loaded definitions
  agents: Map<string, AgentDef>;
  chains: ChainDef[];
}
