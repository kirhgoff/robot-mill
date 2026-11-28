import type { AgentType, Task, TaskKind } from "./store";

export type Slot = { type: AgentType; busy: boolean };
type Assignment = { task: Task; type: AgentType };

const priority: Record<TaskKind, number> = { fix: 0, review: 1, build: 2 };

function pickType(task: Task, free: AgentType[], parentType: AgentType | null) {
  const only = task.kind === "fix" ? parentType : task.pinned_type;
  const allowed = only ? free.filter((type) => type === only) : free;
  if (task.kind === "review") return allowed.find((type) => type !== parentType) ?? allowed[0];
  return allowed[0];
}

export function nextAssignments(queued: Task[], slots: Slot[], parentType: (task: Task) => AgentType | null) {
  const free = slots.filter((slot) => !slot.busy).map((slot) => slot.type);
  const ordered = [...queued].sort((a, b) => priority[a.kind] - priority[b.kind] || a.created_at - b.created_at);
  const assignments: Assignment[] = [];
  for (const task of ordered) {
    const type = pickType(task, free, parentType(task));
    if (!type) continue;
    free.splice(free.indexOf(type), 1);
    assignments.push({ task, type });
  }
  return assignments;
}
