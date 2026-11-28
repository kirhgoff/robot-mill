import { type Runner, runOrThrow } from "./run";

export type Tmux = {
  has(name: string): Promise<boolean>;
  start(name: string, cwd: string, argv: string[], env: Record<string, string>): Promise<void>;
  send(name: string, text: string): Promise<void>;
  kill(name: string): Promise<void>;
  capture(name: string): Promise<string>;
};

export function createTmux(runner: Runner): Tmux {
  return {
    async has(name) {
      return (await runner(["tmux", "has-session", "-t", name])).code === 0;
    },
    async start(name, cwd, argv, env) {
      const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
      await runOrThrow(runner, ["tmux", "new-session", "-d", "-s", name, "-c", cwd, ...envFlags, ...argv]);
    },
    async send(name, text) {
      await runOrThrow(runner, ["tmux", "send-keys", "-t", name, "-l", "--", text]);
      await runOrThrow(runner, ["tmux", "send-keys", "-t", name, "Enter"]);
    },
    async kill(name) {
      await runner(["tmux", "kill-session", "-t", name]);
    },
    async capture(name) {
      return runOrThrow(runner, ["tmux", "capture-pane", "-p", "-t", name]);
    },
  };
}
