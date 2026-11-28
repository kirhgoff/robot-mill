import type { Tmux } from "./tmux";

export type StartedSession = { cwd: string; argv: string[]; env: Record<string, string> };

export class FakeTmux implements Tmux {
  sessions = new Map<string, StartedSession>();
  sent = new Map<string, string[]>();
  panes = new Map<string, string>();

  async has(name: string) {
    return this.sessions.has(name);
  }

  async start(name: string, cwd: string, argv: string[], env: Record<string, string>) {
    this.sessions.set(name, { cwd, argv, env });
  }

  async send(name: string, text: string) {
    this.sent.set(name, [...(this.sent.get(name) ?? []), text]);
  }

  async kill(name: string) {
    this.sessions.delete(name);
  }

  async capture(name: string) {
    return this.panes.get(name) ?? "";
  }
}
