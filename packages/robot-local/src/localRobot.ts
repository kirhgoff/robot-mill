import type { Robot, RobotImplementResult, RobotPlanResult } from '@robot/core';
import type { TaskDetails } from '@robot/core';
import { spawn } from 'node:child_process';

type LocalRobotConfig = {
  planCommand: string;
  implementCommand: string;
};

function runShell(cmd: string, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      const err = Buffer.concat(errChunks).toString('utf8');
      if (code === 0) resolve(out);
      else reject(new Error(`Command failed (${code}): ${cmd}\n${err}`));
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

export class LocalRobot implements Robot {
  constructor(private readonly cfg: LocalRobotConfig) {}

  async plan(input: { task: TaskDetails; repoDir: string }): Promise<RobotPlanResult> {
    const out = await runShell(this.cfg.planCommand, input);
    return JSON.parse(out) as RobotPlanResult;
  }

  async implement(input: { task: TaskDetails; repoDir: string }): Promise<RobotImplementResult> {
    const out = await runShell(this.cfg.implementCommand, input);
    return JSON.parse(out) as RobotImplementResult;
  }
}
