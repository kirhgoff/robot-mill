/**
 * Robot Mill — State Management
 */

import type { RobotState, RobotConfig, ExecutionState } from "./types.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT VALUES
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_CONFIG: RobotConfig = {
  taskSource: "markdown",
  tasksDir: "./tasks",
  reposDir: "./repos",
  branchPrefix: "robot/",
  defaultMainBranch: "main",
};

export function createInitialExecutionState(): ExecutionState {
  return {
    taskId: "",
    taskTitle: "",
    chainName: "",
    steps: [],
    currentStep: 0,
    startTime: 0,
    status: "idle",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createState(): RobotState {
  return {
    config: { ...DEFAULT_CONFIG },
    currentTaskId: null,
    currentWorktree: null,
    execution: createInitialExecutionState(),
    agents: new Map(),
    chains: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION STATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function resetExecution(state: RobotState): void {
  state.execution = createInitialExecutionState();
}

export function startExecution(
  state: RobotState,
  taskId: string,
  taskTitle: string,
  chainName: string,
  agentNames: string[]
): void {
  state.execution = {
    taskId,
    taskTitle,
    chainName,
    steps: agentNames.map((agent) => ({
      agent,
      status: "pending",
      startTime: 0,
      elapsed: 0,
      lastOutput: "",
      fullOutput: "",
      recentLines: [],
    })),
    currentStep: 0,
    startTime: Date.now(),
    status: "running",
  };
}

export function advanceStep(state: RobotState, output: string): void {
  const { execution } = state;
  if (execution.currentStep < execution.steps.length) {
    const step = execution.steps[execution.currentStep];
    step.status = "done";
    step.elapsed = Date.now() - step.startTime;
    step.fullOutput = output;
    // Keep last line for display
    const lines = output.split("\n").filter(Boolean);
    step.lastOutput = lines[lines.length - 1] || "";
    step.recentLines = lines.slice(-5);
  }
  execution.currentStep++;
  if (execution.currentStep < execution.steps.length) {
    const nextStep = execution.steps[execution.currentStep];
    nextStep.status = "running";
    nextStep.startTime = Date.now();
    nextStep.fullOutput = "";
    nextStep.recentLines = [];
  }
}

export function setStepRunning(state: RobotState, stepIndex: number): void {
  if (stepIndex < state.execution.steps.length) {
    const step = state.execution.steps[stepIndex];
    step.status = "running";
    step.startTime = Date.now();
    step.fullOutput = "";
    step.recentLines = [];
    step.lastOutput = "";
  }
}

export function setStepError(state: RobotState, stepIndex: number, error: string): void {
  if (stepIndex < state.execution.steps.length) {
    const step = state.execution.steps[stepIndex];
    step.status = "error";
    step.lastOutput = error.slice(0, 200);
    step.fullOutput = error;
    step.recentLines = error.split("\n").filter(Boolean).slice(-5);
    step.elapsed = Date.now() - step.startTime;
  }
  state.execution.status = "error";
}

export function finishExecution(state: RobotState, success: boolean): void {
  state.execution.status = success ? "done" : "error";
}

export function updateStepElapsed(state: RobotState): void {
  const { execution } = state;
  if (execution.status !== "running") return;
  
  for (const step of execution.steps) {
    if (step.status === "running" && step.startTime > 0) {
      step.elapsed = Date.now() - step.startTime;
    }
  }
}
