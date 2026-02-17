import { runOnce } from '@robot/core';
import { prepareRepo } from '@robot/git';
import { LocalRobot } from '@robot/robot-local';
import { MarkdownTaskSource } from '@robot/tasksource-markdown';

const TASK_DIR = process.env.TASK_DIR ?? '/data/tasks';
const WORKSPACES_DIR = process.env.WORKSPACES_DIR ?? '/data/workspaces';
const ROBOT_ID = process.env.ROBOT_ID ?? 'runner-1';

const PLAN_COMMAND = process.env.ROBOT_PLAN_COMMAND ?? 'cat';
const IMPLEMENT_COMMAND = process.env.ROBOT_IMPLEMENT_COMMAND ?? 'cat';

const SLEEP_MS = Number(process.env.SLEEP_MS ?? '2000');

const taskSource = new MarkdownTaskSource(TASK_DIR);
const robot = new LocalRobot({ planCommand: PLAN_COMMAND, implementCommand: IMPLEMENT_COMMAND });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

while (true) {
  try {
    const res = await runOnce({
      taskSource,
      robot,
      config: { robotId: ROBOT_ID, workspacesDir: WORKSPACES_DIR },
      prepareRepo,
    });
    if (!res.didWork) await sleep(SLEEP_MS);
  } catch (e) {
    console.error(e);
    await sleep(SLEEP_MS);
  }
}
