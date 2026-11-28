import { Database } from "bun:sqlite";

export type AgentType = "claude" | "codex";
export type TaskKind = "build" | "review" | "fix";
export type TaskState =
  | "queued"
  | "running"
  | "waiting_answer"
  | "paused_limit"
  | "pr_open"
  | "done"
  | "canceled"
  | "failed";

export type Task = {
  id: string;
  kind: TaskKind;
  parent: string | null;
  state: TaskState;
  ticket_id: string | null;
  ticket_url: string | null;
  title: string;
  description: string;
  linear_project: string | null;
  pinned_type: AgentType | null;
  agent_type: AgentType | null;
  session: string | null;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  conversation_id: string | null;
  pr_url: string | null;
  failure: string | null;
  created_at: number;
  updated_at: number;
};

export type NewTask = Pick<Task, "kind" | "title"> &
  Partial<Omit<Task, "id" | "created_at" | "updated_at">>;

const schema = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  parent TEXT,
  state TEXT NOT NULL,
  ticket_id TEXT,
  ticket_url TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  linear_project TEXT,
  pinned_type TEXT,
  agent_type TEXT,
  session TEXT,
  repo TEXT,
  branch TEXT,
  worktree TEXT,
  conversation_id TEXT,
  pr_url TEXT,
  failure TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const blank = {
  parent: null,
  state: "queued",
  ticket_id: null,
  ticket_url: null,
  description: "",
  linear_project: null,
  pinned_type: null,
  agent_type: null,
  session: null,
  repo: null,
  branch: null,
  worktree: null,
  conversation_id: null,
  pr_url: null,
  failure: null,
};

function bind(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as Record<string, string | number | null>;
}

export function openStore(path: string) {
  const db = new Database(path);
  db.run(schema);

  function getTask(id: string) {
    return db.query("SELECT * FROM tasks WHERE id = $id").get({ $id: id }) as Task | null;
  }

  function insertTask(fields: NewTask) {
    const count = db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    const now = Date.now();
    const row = { ...blank, ...fields, id: `t${count.n + 1}`, created_at: now, updated_at: now };
    const columns = Object.keys(row);
    db.query(`INSERT INTO tasks (${columns.join(",")}) VALUES (${columns.map((c) => `$${c}`).join(",")})`).run(bind(row));
    return getTask(row.id) as Task;
  }

  function updateTask(id: string, patch: Partial<Omit<Task, "id">>) {
    const row = { ...patch, updated_at: Date.now() };
    const assignments = Object.keys(row).map((c) => `${c} = $${c}`);
    db.query(`UPDATE tasks SET ${assignments.join(",")} WHERE id = $id`).run(bind({ ...row, id }));
    return getTask(id) as Task;
  }

  function listTasks(state?: TaskState) {
    const rows = db.query("SELECT * FROM tasks ORDER BY rowid").all() as Task[];
    return state ? rows.filter((task) => task.state === state) : rows;
  }

  return { getTask, insertTask, updateTask, listTasks };
}

export type Store = ReturnType<typeof openStore>;
