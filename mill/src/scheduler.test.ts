import { expect, test } from "bun:test";
import { nextAssignments } from "./scheduler";
import type { AgentType, Task } from "./store";

let counter = 0;
function task(fields: Partial<Task>): Task {
  counter += 1;
  return {
    id: `t${counter}`, kind: "build", parent: null, state: "queued", ticket_id: null, ticket_url: null, title: "", description: "",
    linear_project: null, pinned_type: null, agent_type: null, session: null, repo: null, branch: null, worktree: null,
    conversation_id: null, pr_url: null, failure: null, last_prompt_at: null, last_signal_at: null, nudges: 0, reset_at: null, limit_line: null, last_activity_at: null, created_at: counter, updated_at: counter, ...fields,
  };
}

const free = (...types: AgentType[]) => types.map((type) => ({ type, busy: false }));
const noParent = () => null;

test("orders fix before review before build, then by age", () => {
  const build = task({ kind: "build" });
  const review = task({ kind: "review" });
  const fix = task({ kind: "fix" });
  const olderBuild = task({ kind: "build", created_at: 0 });
  const result = nextAssignments([build, review, fix, olderBuild], free("claude", "codex", "claude", "codex"), noParent);
  expect(result.map((a) => a.task)).toEqual([fix, review, olderBuild, build]);
});

test("busy slots are not assigned", () => {
  const result = nextAssignments([task({})], [{ type: "claude", busy: true }, { type: "codex", busy: false }], noParent);
  expect(result.map((a) => a.type)).toEqual(["codex"]);
});

test("each slot is used once per round", () => {
  expect(nextAssignments([task({}), task({})], free("claude"), noParent)).toHaveLength(1);
});

test("a pinned task only takes its type and waits otherwise", () => {
  const pinned = task({ pinned_type: "codex" });
  expect(nextAssignments([pinned], free("claude"), noParent)).toEqual([]);
  expect(nextAssignments([pinned], free("claude", "codex"), noParent)[0]?.type).toBe("codex");
});

test("a pinned task that waits does not block a later task", () => {
  const pinned = task({ pinned_type: "codex" });
  const other = task({});
  expect(nextAssignments([pinned, other], free("claude"), noParent).map((a) => a.task)).toEqual([other]);
});

test("a fix task goes to its parent's type only", () => {
  const fix = task({ kind: "fix" });
  expect(nextAssignments([fix], free("claude"), () => "codex")).toEqual([]);
  expect(nextAssignments([fix], free("claude", "codex"), () => "codex")[0]?.type).toBe("codex");
});

test("a review prefers a type different from the parent's", () => {
  const review = task({ kind: "review" });
  expect(nextAssignments([review], free("claude", "codex"), () => "claude")[0]?.type).toBe("codex");
});

test("a review falls back to the parent's type when it is the only free slot", () => {
  const review = task({ kind: "review" });
  expect(nextAssignments([review], free("claude"), () => "claude")[0]?.type).toBe("claude");
});
