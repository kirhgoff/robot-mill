import type { Robot } from './robot.js';
import type { TaskSource } from './taskSource.js';

export type WorkflowConfig = {
  robotId: string;
  workspacesDir: string;
};

export async function runOnce(input: {
  taskSource: TaskSource;
  robot: Robot;
  config: WorkflowConfig;
  prepareRepo: (args: {
    taskId: string;
    repo: string;
    preferredBranch?: string;
    workspacesDir: string;
  }) => Promise<{ repoDir: string; branch: string }>;
}): Promise<{ didWork: boolean }>
{
  const tasks = await input.taskSource.getTaskList();
  const task = tasks[0];
  if (!task) return { didWork: false };

  await input.taskSource.startWorking(task.id, input.config.robotId);
  const details = await input.taskSource.getTaskDetails(task.id);

  const { repoDir } = await input.prepareRepo({
    taskId: details.id,
    repo: details.repo,
    ...(details.branch ? { preferredBranch: details.branch } : {}),
    workspacesDir: input.config.workspacesDir,
  });

  const plan = await input.robot.plan({ task: details, repoDir });
  await input.taskSource.appendDetails(details.id, {
    by: input.config.robotId,
    type: 'plan',
    body: plan.planMarkdown,
  });

  if (plan.kind === 'need_info') {
    await input.taskSource.appendDetails(details.id, {
      by: input.config.robotId,
      type: 'questions',
      body: plan.questionsMarkdown,
    });
    await input.taskSource.stopWorkingNeedInfo(details.id);
    return { didWork: true };
  }

  const impl = await input.robot.implement({ task: details, repoDir });
  await input.taskSource.appendDetails(details.id, {
    by: input.config.robotId,
    type: 'implementation',
    body: impl.notesMarkdown,
  });
  await input.taskSource.stopWorkingNeedReview(details.id);
  return { didWork: true };
}
