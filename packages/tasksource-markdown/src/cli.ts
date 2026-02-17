#!/usr/bin/env bun
import { MarkdownTaskSource } from './markdownTaskSource.js';

function usage(): never {
  console.log(
    [
      'task-md <command> [args]',
      '',
      'Commands:',
      '  list --dir <tasksDir>',
      '  show <id> --dir <tasksDir>',
      '  append <id> --dir <tasksDir> --type <plan|questions|implementation|note> --by <actor> --body <text>',
      '  start <id> --dir <tasksDir> --robot <robotId>',
      '  stop <id> --dir <tasksDir> --need <info|review>',
    ].join('\n'),
  );
  process.exit(1);
}

function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd) usage();

const dir = readFlag(argv, '--dir');
if (!dir) usage();
const ts = new MarkdownTaskSource(dir);

if (cmd === 'list') {
  const list = await ts.getTaskList();
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}

if (cmd === 'show') {
  const id = argv[1];
  if (!id) usage();
  const details = await ts.getTaskDetails(id);
  console.log(JSON.stringify(details, null, 2));
  process.exit(0);
}

if (cmd === 'append') {
  const id = argv[1];
  if (!id) usage();
  const type = readFlag(argv, '--type') as any;
  const by = readFlag(argv, '--by');
  const body = readFlag(argv, '--body');
  if (!type || !by || !body) usage();
  await ts.appendDetails(id, { type, by, body });
  process.exit(0);
}

if (cmd === 'start') {
  const id = argv[1];
  if (!id) usage();
  const robot = readFlag(argv, '--robot');
  if (!robot) usage();
  await ts.startWorking(id, robot);
  process.exit(0);
}

if (cmd === 'stop') {
  const id = argv[1];
  if (!id) usage();
  const need = readFlag(argv, '--need');
  if (!need) usage();
  if (need === 'info') await ts.stopWorkingNeedInfo(id);
  else if (need === 'review') await ts.stopWorkingNeedReview(id);
  else usage();
  process.exit(0);
}

usage();
