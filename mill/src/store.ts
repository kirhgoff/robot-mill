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
  last_prompt_at: number | null;
  last_signal_at: number | null;
  nudges: number;
  reset_at: number | null;
  last_activity_at: number | null;
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
  last_prompt_at INTEGER,
  last_signal_at INTEGER,
  nudges INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER,
  last_activity_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (message_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL);`;

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
  last_prompt_at: null,
  last_signal_at: null,
  nudges: 0,
  reset_at: null,
  last_activity_at: null,
};

function bind(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as Record<string, string | number | null>;
}

export function openStore(path: string) {
  const db = new Database(path);
  db.exec(schema);

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

  function getKv(key: string) {
    return (db.query("SELECT value FROM kv WHERE key = $key").get({ $key: key }) as { value: string } | null)?.value ?? null;
  }

  function setKv(key: string, value: string) {
    db.query("INSERT OR REPLACE INTO kv (key, value) VALUES ($key, $value)").run({ $key: key, $value: value });
  }

  function addQuestion(messageId: number, taskId: string) {
    db.query("INSERT OR REPLACE INTO questions (message_id, task_id) VALUES ($messageId, $taskId)").run({ $messageId: messageId, $taskId: taskId });
  }

  function questionTask(messageId: number) {
    return (db.query("SELECT task_id FROM questions WHERE message_id = $messageId").get({ $messageId: messageId }) as { task_id: string } | null)?.task_id ?? null;
  }

  return { getTask, insertTask, updateTask, listTasks, getKv, setKv, addQuestion, questionTask };
}

export type Store = ReturnType<typeof openStore>;
