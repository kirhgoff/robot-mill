import type { AppendDetailsEntry, TaskDetails, TaskSummary } from './task.js';

export class AlreadyClaimedError extends Error {
  override name = 'AlreadyClaimedError';
}

export interface TaskSource {
  getTaskList(): Promise<TaskSummary[]>;
  getTaskDetails(id: string): Promise<TaskDetails>;
  appendDetails(id: string, entry: AppendDetailsEntry): Promise<void>;
  startWorking(id: string, robotId: string): Promise<void>;
  stopWorkingNeedInfo(id: string): Promise<void>;
  stopWorkingNeedReview(id: string): Promise<void>;
}
