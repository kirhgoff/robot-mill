/**
 * Robot Mill — Git Operations Tool
 * 
 * Tools:
 * - git_ops: status, commit, push, pull
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RobotState } from "../types.ts";
import { git } from "../helpers/git.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const GitOpsSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("status"),
    Type.Literal("commit"),
    Type.Literal("push"),
    Type.Literal("pull"),
  ]),
  message: Type.Optional(Type.String({ description: "Commit message (for commit operation)" })),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export function registerGitTools(pi: ExtensionAPI, state: RobotState): void {
  pi.registerTool({
    name: "git_ops",
    description: "Git operations in current worktree: status, commit, push, pull",
    parameters: GitOpsSchema,

    async execute(_id, params, _signal, _onUpdate, _ctx) {
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
              return {
                content: [{ type: "text", text: "Error: commit message required" }],
                isError: true,
              };
            }
            await git("add -A", cwd);
            await git(`commit -m "${params.message.replace(/"/g, '\\"')}"`, cwd);
            const hash = await git("rev-parse --short HEAD", cwd);
            return {
              content: [{ type: "text", text: `✓ Committed: ${hash}` }],
            };
          }

          case "push": {
            const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
            await git(`push -u origin ${branch}`, cwd);
            return {
              content: [{ type: "text", text: `✓ Pushed to origin/${branch}` }],
            };
          }

          case "pull": {
            await git("pull --rebase", cwd);
            return {
              content: [{ type: "text", text: `✓ Pulled latest changes` }],
            };
          }
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Git error: ${err}` }],
          isError: true,
        };
      }
    },
  });
}
