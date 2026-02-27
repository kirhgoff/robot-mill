/**
 * Robot Mill — TUI Widget
 * 
 * Displays real-time execution status:
 * - Current task being worked on
 * - Chain being executed  
 * - Current agent/step with progress bar
 * - Elapsed time
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { RobotState, StepState } from "../types.ts";
import { updateStepElapsed } from "../state.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// WIDGET STATE
// ═══════════════════════════════════════════════════════════════════════════════

let widgetCtx: ExtensionContext | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let stateRef: RobotState | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);

  if (hours > 0) return `${hours}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function getStepIcon(status: StepState["status"]): string {
  switch (status) {
    case "pending": return "○";
    case "running": return "●";
    case "done": return "✓";
    case "error": return "✗";
  }
}

function getStepColor(status: StepState["status"]): string {
  switch (status) {
    case "pending": return "dim";
    case "running": return "accent";
    case "done": return "success";
    case "error": return "error";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WIDGET RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

export function updateWidget(): void {
  if (!widgetCtx || !stateRef) return;

  const state = stateRef;

  widgetCtx.ui.setWidget("robot-mill-status", (_tui, theme) => {
    const container = new Container();

    return {
      render(width: number): string[] {
        const { execution, currentTaskId } = state;
        const lines: string[] = [];
        const w = width - 2;

        // ─── Header Border ───────────────────────────────────────────────────
        const borderColor = execution.status === "running" ? "accent"
          : execution.status === "done" ? "success"
          : execution.status === "error" ? "error"
          : "dim";
        
        lines.push(theme.fg(borderColor, "─".repeat(w)));

        // ─── Idle State ──────────────────────────────────────────────────────
        if (execution.status === "idle") {
          if (currentTaskId) {
            lines.push(
              theme.fg("dim", " Task: ") + 
              theme.fg("text", currentTaskId) +
              theme.fg("dim", " (idle)")
            );
          } else {
            lines.push(theme.fg("dim", " 🤖 Robot Mill — No task loaded"));
          }
          lines.push(theme.fg(borderColor, "─".repeat(w)));
          
          const text = new Text(lines.join("\n"), 0, 0);
          return text.render(width);
        }

        // ─── Active Execution ────────────────────────────────────────────────
        
        // Line 1: Task + Chain
        const statusIcon = execution.status === "running" ? "●"
          : execution.status === "done" ? "✓" : "✗";
        const statusColor = execution.status === "running" ? "accent"
          : execution.status === "done" ? "success" : "error";

        lines.push(
          theme.fg(statusColor, ` ${statusIcon} `) +
          theme.fg("text", truncateToWidth(execution.taskTitle || execution.taskId, w - 30)) +
          theme.fg("dim", " → ") +
          theme.fg("accent", execution.chainName)
        );

        // Line 2: Progress bar with step indicators
        const totalSteps = execution.steps.length;
        const currentStep = Math.min(execution.currentStep + 1, totalSteps);
        const progress = currentStep / totalSteps;

        // Build step indicator line: [✓ understand] → [● planner] → [○ builder]
        const stepIndicators: string[] = [];
        for (let i = 0; i < execution.steps.length; i++) {
          const step = execution.steps[i];
          const icon = getStepIcon(step.status);
          const color = getStepColor(step.status);
          const name = capitalize(step.agent);
          
          if (step.status === "running") {
            stepIndicators.push(
              theme.fg(color, `[${icon} `) +
              theme.fg(color, theme.bold(name)) +
              theme.fg(color, "]")
            );
          } else {
            stepIndicators.push(theme.fg(color, `[${icon} ${name}]`));
          }
        }

        // Join with arrows, wrapping if needed
        const stepLine = stepIndicators.join(theme.fg("dim", " → "));
        lines.push(" " + truncateToWidth(stepLine, w - 2));

        // Line 3: Progress bar + percentage + elapsed
        const barWidth = Math.min(25, w - 30);
        const filled = Math.round(progress * barWidth);
        const empty = barWidth - filled;
        const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
        const pct = Math.round(progress * 100);
        
        // Calculate total elapsed
        const totalElapsed = execution.startTime > 0 ? Date.now() - execution.startTime : 0;
        
        lines.push(
          theme.fg("dim", " Progress: ") +
          bar + " " +
          theme.fg("accent", `${pct}%`) +
          theme.fg("dim", " │ Total: ") +
          theme.fg("text", formatElapsed(totalElapsed))
        );

        // Find the running step
        const runningStep = execution.steps.find(s => s.status === "running");
        
        // Line 4+: Current agent output box (if running)
        if (runningStep) {
          // Agent header with elapsed time
          const agentElapsed = runningStep.startTime > 0 
            ? Date.now() - runningStep.startTime 
            : 0;
          
          lines.push(
            theme.fg("dim", " ┌─ ") + 
            theme.fg("warning", theme.bold(capitalize(runningStep.agent))) +
            theme.fg("dim", ` (${formatElapsed(agentElapsed)})`)
          );
          
          // Show recent output lines (up to 5)
          const recentLines = runningStep.recentLines || [];
          if (recentLines.length > 0) {
            for (let i = 0; i < recentLines.length; i++) {
              const line = recentLines[i];
              const isLast = i === recentLines.length - 1;
              const prefix = isLast ? " └─ " : " │  ";
              const maxLineWidth = w - 6;
              const truncatedLine = truncateToWidth(line, maxLineWidth);
              lines.push(theme.fg("dim", prefix) + theme.fg("muted", truncatedLine));
            }
          } else if (runningStep.lastOutput) {
            // Fallback to lastOutput if recentLines not available
            const truncatedLine = truncateToWidth(runningStep.lastOutput, w - 6);
            lines.push(theme.fg("dim", " └─ ") + theme.fg("muted", truncatedLine));
          } else {
            lines.push(theme.fg("dim", " └─ ") + theme.fg("dim", "(working...)"));
          }
        }

        // Show completed steps summary if any
        const completedSteps = execution.steps.filter(s => s.status === "done");
        if (completedSteps.length > 0 && execution.status === "running") {
          lines.push(theme.fg("dim", " "));
          lines.push(
            theme.fg("dim", " Completed: ") + 
            completedSteps.map(s => 
              theme.fg("success", `✓${capitalize(s.agent)}`) + 
              theme.fg("dim", `(${formatElapsed(s.elapsed)})`)
            ).join(theme.fg("dim", " "))
          );
        }

        // ─── Footer Border ───────────────────────────────────────────────────
        lines.push(theme.fg(borderColor, "─".repeat(w)));

        const text = new Text(lines.join("\n"), 0, 0);
        return text.render(width);
      },

      invalidate() {
        container.invalidate();
      },
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOTER
// ═══════════════════════════════════════════════════════════════════════════════

export function setupFooter(ctx: ExtensionContext, state: RobotState): void {
  ctx.ui.setFooter((_tui, theme) => ({
    dispose: () => {},
    invalidate() {},
    render(width: number): string[] {
      const { execution, currentTaskId } = state;
      const model = ctx.model?.id || "no-model";
      
      // Left side: model + task
      const modelStr = theme.fg("dim", ` ${model}`);
      const taskStr = currentTaskId 
        ? theme.fg("dim", " · ") + theme.fg("accent", currentTaskId)
        : "";
      
      // Right side: execution status
      let statusStr = "";
      if (execution.status === "running") {
        const step = execution.steps.find(s => s.status === "running");
        statusStr = theme.fg("dim", " · ") + 
          theme.fg("warning", step?.agent || "...") +
          theme.fg("dim", ` ${execution.currentStep + 1}/${execution.steps.length}`);
      } else if (execution.status !== "idle") {
        const icon = execution.status === "done" ? "✓" : "✗";
        const color = execution.status === "done" ? "success" : "error";
        statusStr = theme.fg("dim", " · ") + theme.fg(color, icon);
      }

      return [truncateToWidth(modelStr + taskStr + statusStr, width)];
    },
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export function initWidget(ctx: ExtensionContext, state: RobotState): void {
  widgetCtx = ctx;
  stateRef = state;
  updateWidget();
  setupFooter(ctx, state);
}

export function startUpdateTimer(): void {
  if (updateTimer) return;
  
  updateTimer = setInterval(() => {
    if (stateRef && stateRef.execution.status === "running") {
      updateStepElapsed(stateRef);
      updateWidget();
    }
  }, 500); // Update every 500ms for smooth elapsed time
}

export function stopUpdateTimer(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

export function disposeWidget(): void {
  stopUpdateTimer();
  if (widgetCtx) {
    widgetCtx.ui.setWidget("robot-mill-status", undefined);
    widgetCtx = null;
  }
  stateRef = null;
}
