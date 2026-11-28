export type RunResult = { code: number; stdout: string };
export type Runner = (argv: string[], cwd?: string) => Promise<RunResult>;

export const run: Runner = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: code === 0 ? stdout : `${stdout}${stderr}` };
};

export async function runOrThrow(runner: Runner, argv: string[], cwd?: string) {
  const result = await runner(argv, cwd);
  if (result.code !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stdout}`);
  return result.stdout;
}
