import { type Runner, runOrThrow } from "./run";

export const owner = "kirhgoff";

export type Gh = (method: string, path: string, body?: unknown) => Promise<any>;

export function createGh(runner: Runner): Gh {
  return async (method, path, body) => {
    const argv = ["gh", "api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])];
    const out = await runOrThrow(runner, argv, undefined, body === undefined ? undefined : JSON.stringify(body));
    return out.trim() ? JSON.parse(out) : null;
  };
}

export function parsePr(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) throw new Error(`not a pull request url: ${url}`);
  return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) };
}
