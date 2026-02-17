import type { TaskDetails } from './task.js';

export type RobotPlanResult =
  | {
      kind: 'need_info';
      planMarkdown: string;
      questionsMarkdown: string;
    }
  | {
      kind: 'ready';
      planMarkdown: string;
    };

export type RobotImplementResult = {
  notesMarkdown: string;
};

export interface Robot {
  plan(input: { task: TaskDetails; repoDir: string }): Promise<RobotPlanResult>;
  implement(input: { task: TaskDetails; repoDir: string }): Promise<RobotImplementResult>;
}
