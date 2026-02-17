export type TaskStatus = 'todo' | 'in_progress' | 'in_review';

export type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  buddy: string;
  repo: string;
  branch?: string;
};

export type TaskDetails = TaskSummary & {
  assignedTo: string | null;
  description: string;
  detailsFeed: Array<{
    at: string;
    by: string;
    type: 'plan' | 'questions' | 'implementation' | 'note';
    body: string;
  }>;
};

export type AppendDetailsEntry = {
  by: string;
  type: 'plan' | 'questions' | 'implementation' | 'note';
  body: string;
  at?: string;
};
