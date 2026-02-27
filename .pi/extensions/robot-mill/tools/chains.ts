/**
 * Robot Mill — Chain Execution Tools
 * 
 * Tools:
 * - run_mill: Execute a workflow chain
 * - need_clarification: Pause and ask human for info
 * - submit_work: Submit completed work for review
 * 
 * Workflow Transitions:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  todo ──[full-mill/quick-mill]──► in_progress                          │
 * │           │                            │                                │
 * │           │                     [clarify]                               │
 * │           │                            ▼                                │
 * │           │                      needs_info ◄──────┐                    │
 * │           │                            │           │                    │
 * │           │                [resume-from-clarify]   │                    │
 * │           │                            │           │                    │
 * │           │                            ▼           │                    │
 * │           └────────────────► in_progress ──────────┘                    │
 * │                                   │                                     │
 * │                            [test-review]                                │
 * │                                   ▼                                     │
 * │                              in_review                                  │
 * │                                   │                                     │
 * │                     ┌─────────────┴─────────────┐                       │
 * │                     │                           │                       │
 * │                (approved)              (changes requested)              │
 * │                     │                 [resume-from-review]              │
 * │                     ▼                           │                       │
 * │                   done                          └──► in_progress        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { join } from "path";
import type { RobotState } from "../types.ts";
import { startExecution, resetExecution } from "../state.ts";
import { runChain } from "../helpers/agents.ts";
import { readTask, writeTask } from "./tasks.ts";
import { updateWidget, startUpdateTimer, stopUpdateTimer } from "../ui/widget.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAIN SELECTION GUIDE
// ═══════════════════════════════════════════════════════════════════════════════

const CHAIN_GUIDE = `
## Chain Selection Guide

| Situation | Chain | Transition |
|-----------|-------|------------|
| New task, full process | \`full-mill\` | todo → in_progress → in_review |
| Quick implementation | \`quick-mill\` | todo → in_progress |
| Requirements unclear | \`clarify\` | in_progress → needs_info |
| Just need a plan | \`plan-only\` | (no transition) |
| After human answered questions | \`resume-from-clarify\` | needs_info → in_progress |
| After human approved plan | \`resume-from-plan\` | needs_info → in_progress |
| After human review feedback | \`resume-from-review\` | in_review → in_progress |
| Test and review changes | \`test-review\` | in_progress → in_review |
`;

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const RunMillSchema = Type.Object({
  chain: Type.String({
    description:
      "Chain to run: full-mill, quick-mill, clarify, plan-only, resume-from-clarify, resume-from-plan, resume-from-review, test-review, build-test",
  }),
  context: Type.Optional(Type.String({ description: "Additional context for the chain" })),
});

const NeedClarificationSchema = Type.Object({
  questions: Type.String({
    description: "Formatted questions to ask (use 'clarify' chain first to identify questions)",
  }),
});

const SubmitWorkSchema = Type.Object({
  summary: Type.String({ description: "Summary of changes made" }),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function registerChainTools(pi: ExtensionAPI, state: RobotState): void {
  // ─────────────────────────────────────────────────────────────────────────────
  // run_mill
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "run_mill",
    label: "Run Mill Chain",
    description:
      "Execute a workflow chain on the current task. Each chain runs multiple agents in sequence.\n\n" +
      "Available chains:\n" +
      "- full-mill: Complete workflow (understand → plan → build → test → review)\n" +
      "- quick-mill: Fast implementation (understand → plan → build)\n" +
      "- clarify: Identify unclear requirements (understand → clarifier)\n" +
      "- plan-only: Just create a plan (understand → planner)\n" +
      "- resume-from-clarify: Continue after human answered questions\n" +
      "- resume-from-plan: Continue after human approved plan\n" +
      "- resume-from-review: Address review feedback\n" +
      "- test-review: Test and review existing changes\n" +
      "- build-test: Build and test (skip planning)",
    parameters: RunMillSchema,

    async execute(_id, params, _signal, onUpdate, ctx) {
      const { chain: chainName, context } = params;

      // Find the chain
      const chain = state.chains.find((c) => c.name === chainName);
      if (!chain) {
        const available = state.chains.map((c) => c.name).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Chain "${chainName}" not found.\n\nAvailable chains: ${available}\n${CHAIN_GUIDE}`,
            },
          ],
          isError: true,
        };
      }

      // Get current task
      if (!state.currentTaskId) {
        return {
          content: [
            {
              type: "text",
              text: "No task loaded. Use `workflow next` to pick up a task first.",
            },
          ],
          isError: true,
        };
      }

      const task = await readTask(state, ctx.cwd, state.currentTaskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${state.currentTaskId}` }],
          isError: true,
        };
      }

      // Build task prompt
      let taskPrompt = `## Task: ${task.title}\n\n${task.description}`;
      if (task.notes.length > 0) {
        taskPrompt +=
          "\n\n## Previous Work\n" +
          task.notes.map((n) => `### ${n.type} (${n.author})\n${n.content}`).join("\n\n");
      }
      if (context) {
        taskPrompt += `\n\n## Additional Context\n${context}`;
      }

      // Initialize execution state
      startExecution(
        state,
        task.id,
        task.title,
        chain.name,
        chain.steps.map((s) => s.agent)
      );
      startUpdateTimer();
      updateWidget();

      onUpdate?.({
        content: [{ type: "text", text: `Running ${chain.name}...` }],
        details: { chain: chain.name, status: "running" },
      });

      // Get model for sub-agents
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "anthropic/claude-sonnet-4-20250514";
      const sessionDir = join(ctx.cwd, ".pi", "agent-sessions");

      // Map agent names to note types for better categorization
      const agentToNoteType: Record<string, "plan" | "question" | "progress" | "review" | "general"> = {
        understand: "general",
        planner: "plan",
        builder: "progress",
        tester: "progress",
        reviewer: "review",
        clarifier: "question",
      };

      // Run the chain with callbacks to save each step's output
      const result = await runChain(chain, taskPrompt, state, sessionDir, model, {
        // Update widget during output
        onStepOutput: (_stepIndex, _chunk, _fullOutput) => {
          updateWidget();
        },
        
        // Save each agent's output to task notes as it completes
        onStepComplete: async (stepIndex, agent, output, elapsed) => {
          const noteType = agentToNoteType[agent.toLowerCase()] || "progress";
          const elapsedSecs = Math.round(elapsed / 1000);
          
          // Create a header for the note
          const header = `## ${capitalize(agent)} Agent (${elapsedSecs}s)`;
          
          // Truncate if too long but keep more than before
          const maxLen = 4000;
          const truncated = output.length > maxLen 
            ? output.slice(0, maxLen) + "\n\n[...truncated]"
            : output;
          
          task.notes.push({
            timestamp: new Date().toISOString(),
            author: agent.toLowerCase(),
            type: noteType,
            content: `${header}\n\n${truncated}`,
          });
          
          // Save task after each step so progress is persisted
          await writeTask(state, ctx.cwd, task);
          updateWidget();
        },
      });

      stopUpdateTimer();
      updateWidget();

      // Save final summary note
      if (result.success) {
        const stepSummary = result.stepOutputs
          .map((s, i) => `${i + 1}. **${capitalize(s.agent)}** (${Math.round(s.elapsed / 1000)}s)`)
          .join("\n");
        
        task.notes.push({
          timestamp: new Date().toISOString(),
          author: "robot",
          type: "progress",
          content: `## Chain Complete: ${chain.name}\n\n### Steps Executed\n${stepSummary}\n\n### Final Output\n\n${result.output.slice(0, 1500)}${result.output.length > 1500 ? "\n[truncated]" : ""}`,
        });
        await writeTask(state, ctx.cwd, task);
      }

      const truncated = result.output.length > 6000 ? result.output.slice(0, 6000) + "\n[truncated]" : result.output;

      return {
        content: [
          {
            type: "text",
            text: `[${chain.name}] ${result.success ? "✓ completed" : "✗ failed"} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}`,
          },
        ],
        details: { chain: chain.name, success: result.success, elapsed: result.elapsed },
      };
    },

    renderCall(args, theme) {
      const chain = (args as any).chain || "?";
      return new Text(theme.fg("toolTitle", theme.bold("run_mill ")) + theme.fg("accent", chain), 0, 0);
    },

    renderResult(result, opts, theme) {
      const d = result.details as any;
      if (!d) return new Text(result.content[0]?.text || "", 0, 0);
      if (opts.isPartial) {
        return new Text(theme.fg("accent", `● ${d.chain} running...`), 0, 0);
      }
      const icon = d.success ? "✓" : "✗";
      const color = d.success ? "success" : "error";
      return new Text(
        theme.fg(color, `${icon} ${d.chain}`) + theme.fg("dim", ` ${Math.round(d.elapsed / 1000)}s`),
        0,
        0
      );
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // need_clarification
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "need_clarification",
    label: "Need Clarification",
    description:
      "Pause work and ask the human buddy for clarification. " +
      "Use the 'clarify' chain first to identify questions.\n\n" +
      "Transition: in_progress → needs_info",
    parameters: NeedClarificationSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.currentTaskId) {
        return {
          content: [{ type: "text", text: "No task loaded" }],
          isError: true,
        };
      }

      const task = await readTask(state, ctx.cwd, state.currentTaskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${state.currentTaskId}` }],
          isError: true,
        };
      }

      // Add questions as note
      task.notes.push({
        timestamp: new Date().toISOString(),
        author: "robot",
        type: "question",
        content: params.questions,
      });

      // Transition: in_progress → needs_info
      task.status = "needs_info";
      task.assignee = task.humanBuddy;
      await writeTask(state, ctx.cwd, task);

      // Clear current task (robot waits for human)
      state.currentTaskId = null;
      resetExecution(state);
      updateWidget();

      ctx.shutdown();

      return {
        content: [
          {
            type: "text",
            text: `⏸ Questions posted. Task "${task.id}" assigned to ${task.humanBuddy}.\n\nWorkflow paused. Resume with \`resume-from-clarify\` after human provides answers.`,
          },
        ],
        details: { taskId: task.id, assignedTo: task.humanBuddy },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("need_clarification")), 0, 0);
    },

    renderResult(result, _opts, theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ " + result.content[0]?.text), 0, 0);
      return new Text(theme.fg("warning", "⏸ Paused — waiting for human"), 0, 0);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // submit_work
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "submit_work",
    label: "Submit Work",
    description:
      "Submit completed work for human review. Include a summary of what was done.\n\n" +
      "Transition: in_progress → in_review",
    parameters: SubmitWorkSchema,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.currentTaskId) {
        return {
          content: [{ type: "text", text: "No task loaded" }],
          isError: true,
        };
      }

      const task = await readTask(state, ctx.cwd, state.currentTaskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${state.currentTaskId}` }],
          isError: true,
        };
      }

      // Add submission summary
      task.notes.push({
        timestamp: new Date().toISOString(),
        author: "robot",
        type: "review",
        content: `## Submission Summary\n\n${params.summary}`,
      });

      // Transition: in_progress → in_review
      task.status = "in_review";
      task.assignee = task.humanBuddy;
      await writeTask(state, ctx.cwd, task);

      // Clear current task
      state.currentTaskId = null;
      resetExecution(state);
      updateWidget();

      ctx.shutdown();

      return {
        content: [
          {
            type: "text",
            text: `✓ Work submitted. Task "${task.id}" assigned to ${task.humanBuddy} for review.`,
          },
        ],
        details: { taskId: task.id, summary: params.summary },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("submit_work")), 0, 0);
    },

    renderResult(result, _opts, theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ " + result.content[0]?.text), 0, 0);
      return new Text(theme.fg("success", "✓ Submitted for review"), 0, 0);
    },
  });
}
