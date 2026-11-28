import { beforeEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createReviewPoster, signAppJwt, type ReviewInput } from "./github-app";
import { createGithubWebhook } from "./github-webhook";
import type { Gh } from "./github";
import { startServer } from "./http";
import type { Notifier } from "./notifier";
import { createCheckRepo, protectRepo } from "./protect";
import { openStore } from "./store";
import { createTasks } from "./tasks";
import { FakeTmux } from "./tmux.fake";
import type { Tracker } from "./tracker";
import { createGit } from "./worktree";

const prUrl = "https://github.com/kirhgoff/widgets/pull/1";

let tmux: FakeTmux;
let commands: string[][];
let sentTexts: string[];
let moves: string[];
let posted: ReviewInput[];
let tasks: ReturnType<typeof createTasks>;
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let webhook: (request: Request) => Promise<Response>;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "mill-"));
  tmux = new FakeTmux();
  commands = [];
  sentTexts = [];
  moves = [];
  posted = [];
  timers = [];
  const notifier: Notifier = {
    send: async (text) => sentTexts.push(text),
    ask: async () => 1,
  };
  const tracker: Tracker = {
    create: async () => ({ id: "KIR-1", url: "https://linear.app/KIR-1" }),
    move: async (id, state) => void moves.push(`${id} ${state}`),
    comment: async () => {},
  };
  tasks = createTasks({
    store: openStore(":memory:"),
    tmux,
    git: createGit(join(root, "projects"), async (argv) => {
      commands.push(argv);
      return { code: 0, stdout: "" };
    }),
    tracker,
    notifier,
    pool: ["claude", "codex"],
    sessionsDir: join(root, "sessions"),
    baseUrl: () => "http://127.0.0.1:1",
    hookCommand: ["mill-hook"],
    checkRepo: async () => {},
    postReview: async (_url, review) => void posted.push(review),
  });
  webhook = createGithubWebhook({
    secret: "s3cret",
    tasks,
    botLogin: "millwright",
    appLogin: "mill-inspector[bot]",
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
});

async function openPr() {
  await tasks.submit({ title: "Widget", description: "", linear_project: "p" });
  await tasks.complete(tasks.get("t1")!, { pr_url: prUrl });
}

function deliver(event: string, payload: object, secret = "s3cret") {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return webhook(new Request("http://x/github", { method: "POST", body: raw, headers: { "x-hub-signature-256": signature, "x-github-event": event } }));
}

const comment = (login: string) => deliver("issue_comment", { action: "created", sender: { login }, issue: { pull_request: { html_url: prUrl } } });
const liveTimers = () => timers.filter((timer) => !timer.cancelled);

test("a bad signature is rejected", async () => {
  await openPr();
  expect((await deliver("pull_request", { action: "closed" }, "wrong")).status).toBe(401);
});

test("an unknown pull request is ignored", async () => {
  expect((await comment("kirhgoff")).status).toBe(200);
  expect(timers).toEqual([]);
});

test("a merged pull request moves the ticket to Done, removes the worktree and tells Telegram", async () => {
  await openPr();
  await tasks.prepareWorktree(tasks.get("t1")!, "widgets");
  await deliver("pull_request", { action: "closed", pull_request: { html_url: prUrl, merged: true } });
  expect(moves).toContain("KIR-1 Done");
  expect(tasks.get("t1")?.state).toBe("done");
  expect(tasks.get("t2")?.state).toBe("canceled");
  expect(commands.some((argv) => argv.slice(0, 3).join(" ") === "git worktree remove")).toBe(true);
  expect(sentTexts).toContain(`KIR-1: merged: ${prUrl}`);
});

test("a closed unmerged pull request moves the ticket to Canceled", async () => {
  await openPr();
  await deliver("pull_request", { action: "closed", pull_request: { html_url: prUrl, merged: false } });
  expect(moves).toContain("KIR-1 Canceled");
  expect(tasks.get("t1")?.state).toBe("canceled");
  expect(sentTexts).toContain(`KIR-1: closed: ${prUrl}`);
});

test("a human comment queues one fix after the debounce and a second comment resets it", async () => {
  await openPr();
  await comment("kirhgoff");
  await comment("kirhgoff");
  expect(timers.map((timer) => timer.cancelled)).toEqual([true, false]);
  expect(liveTimers()[0]?.ms).toBe(180_000);
  expect(tasks.list().filter((task) => task.kind === "fix")).toEqual([]);
  liveTimers()[0]?.fn();
  await Promise.resolve();
  expect(tasks.list().filter((task) => task.kind === "fix")).toHaveLength(1);
  await comment("kirhgoff");
  liveTimers()[0]?.fn();
  await Promise.resolve();
  expect(tasks.list().filter((task) => task.kind === "fix")).toHaveLength(1);
});

test("millwright and mill-inspector activity triggers nothing", async () => {
  await openPr();
  await comment("millwright");
  await comment("mill-inspector[bot]");
  await deliver("pull_request_review", { action: "submitted", sender: { login: "mill-inspector[bot]" }, pull_request: { html_url: prUrl } });
  expect(timers).toEqual([]);
});

async function reviewRound(review: ReviewInput) {
  const reviewTask = tasks.list().findLast((task) => task.kind === "review" && task.state === "running")!;
  await tasks.prepareWorktree(reviewTask, "widgets");
  await tasks.submitReview(reviewTask, review);
}

const findings: ReviewInput = { event: "COMMENT", body: "see inline", comments: [{ path: "a.ts", line: 3, body: "bug" }] };
const clean: ReviewInput = { event: "COMMENT", body: "lgtm", comments: [] };

test("a review worktree is the detached PR head", async () => {
  await openPr();
  const reviewTask = tasks.get("t2")!;
  const path = await tasks.prepareWorktree(reviewTask, "widgets");
  expect(path.endsWith("widgets-review-1")).toBe(true);
  expect(commands.map((argv) => argv.join(" ")).filter((line) => line.startsWith("git"))).toEqual([
    "git fetch origin pull/1/head",
    `git worktree add --detach ${path} FETCH_HEAD`,
  ]);
});

test("a review with findings queues a fix and counts the round", async () => {
  await openPr();
  await reviewRound(findings);
  expect(posted).toEqual([findings]);
  expect(tasks.get("t2")?.state).toBe("done");
  expect(tasks.list().find((task) => task.kind === "fix")).toMatchObject({ parent: "t1", state: "running" });
  expect(sentTexts.some((text) => text.includes("PR ready"))).toBe(false);
});

test("a clean review tells Kirill the PR is ready", async () => {
  await openPr();
  await reviewRound(clean);
  expect(tasks.list().some((task) => task.kind === "fix")).toBe(false);
  expect(sentTexts).toContain(`KIR-1: PR ready for you: ${prUrl}`);
});

test("REQUEST_CHANGES without comments counts as findings", async () => {
  await openPr();
  await reviewRound({ event: "REQUEST_CHANGES", body: "no", comments: [] });
  expect(tasks.list().some((task) => task.kind === "fix")).toBe(true);
});

test("after a fix a second review is queued, and after round 2 the fix ends the loop", async () => {
  await openPr();
  await reviewRound(findings);
  await tasks.complete(tasks.list().find((task) => task.kind === "fix")!, {});
  const second = tasks.list().filter((task) => task.kind === "review");
  expect(second).toHaveLength(2);
  expect(sentTexts.some((text) => text.includes("PR ready"))).toBe(false);
  await reviewRound(findings);
  await tasks.complete(tasks.list().findLast((task) => task.kind === "fix")!, {});
  expect(tasks.list().filter((task) => task.kind === "review")).toHaveLength(2);
  expect(sentTexts).toContain(`KIR-1: PR ready for you: ${prUrl}`);
});

async function withClient(session: string, work: (client: Client) => Promise<void>) {
  const server = startServer(0, tasks);
  try {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp?session=${session}`)));
    await work(client);
  } finally {
    server.stop(true);
  }
}

const resultText = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]?.text ?? "";

test("a review session posts a COMMENT review over MCP", async () => {
  await openPr();
  await withClient("mill-t2", async (client) => {
    const result = await client.callTool({ name: "submit_review", arguments: { task: "t2", event: "COMMENT", body: "lgtm", comments: [] } });
    expect(result.isError).toBeFalsy();
    expect(posted).toEqual([clean]);
    expect(tasks.get("t2")?.state).toBe("done");
  });
});

test("submit_review refuses APPROVE at the schema", async () => {
  await openPr();
  await withClient("mill-t2", async (client) => {
    const result = await client.callTool({ name: "submit_review", arguments: { task: "t2", event: "APPROVE", body: "ok", comments: [] } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("COMMENT");
    expect(resultText(result)).toContain("REQUEST_CHANGES");
    expect(posted).toEqual([]);
  });
});

test("a build session does not see submit_review", async () => {
  await openPr();
  await withClient("mill-t1", async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("submit_review");
  });
});

function fakeGh(rules: object[], invitations: object[] = []) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const gh: Gh = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "user/repository_invitations") return invitations;
    if (path === "repos/kirhgoff/widgets") return { default_branch: "main" };
    if (path.endsWith("/rules/branches/main")) return rules;
    if (path === "repos/kirhgoff/widgets/rulesets" && method === "GET") return [];
    return null;
  };
  return { gh, calls };
}

const approvals = (count: number) => [{ type: "pull_request", parameters: { required_approving_review_count: count } }];

test("checkRepo refuses a repo with 0 approvals and accepts 1", async () => {
  await expect(createCheckRepo(fakeGh(approvals(0)).gh)("widgets")).rejects.toThrow("Run: mill protect widgets");
  await expect(createCheckRepo(fakeGh([]).gh)("widgets")).rejects.toThrow("Run: mill protect widgets");
  await createCheckRepo(fakeGh(approvals(1)).gh)("widgets");
});

test("checkRepo accepts a pending invitation first", async () => {
  const { gh, calls } = fakeGh(approvals(1), [{ id: 42, repository: { full_name: "kirhgoff/widgets" } }]);
  await createCheckRepo(gh)("widgets");
  expect(calls[1]).toEqual({ method: "PATCH", path: "user/repository_invitations/42", body: undefined });
});

test("protect creates the ruleset and invites the bot, or updates an existing ruleset", async () => {
  const created = fakeGh([]);
  await protectRepo(created.gh, "widgets", "millwright");
  const post = created.calls.find((call) => call.method === "POST");
  expect(post?.path).toBe("repos/kirhgoff/widgets/rulesets");
  expect(post?.body).toMatchObject({
    name: "robot-mill-guard",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
  });
  expect(created.calls.at(-1)).toEqual({ method: "PUT", path: "repos/kirhgoff/widgets/collaborators/millwright", body: { permission: "push" } });

  const calls: string[] = [];
  const gh: Gh = async (method, path) => {
    calls.push(`${method} ${path}`);
    return method === "GET" ? [{ id: 9, name: "robot-mill-guard" }] : null;
  };
  await protectRepo(gh, "widgets", "millwright");
  expect(calls).toContain("PUT repos/kirhgoff/widgets/rulesets/9");
});

test("the App JWT carries iss, iat and exp and verifies with the public key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = signAppJwt("123", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_000_000_000_000);
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "123", iat: 999_999_940, exp: 1_000_000_540 });
  expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
});

test("the review poster exchanges the JWT for an installation token and posts RIGHT-side comments", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(mkdtempSync(join(tmpdir(), "key-")), "app.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const requests: { url: string; method: string; auth: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method as string, auth: (init.headers as Record<string, string>).authorization as string, body: init.body ? JSON.parse(init.body as string) : undefined });
    const data = url.endsWith("/installation") ? { id: 7 } : url.endsWith("/access_tokens") ? { token: "ghs_x" } : {};
    return new Response(JSON.stringify(data));
  }) as unknown as typeof fetch;
  await createReviewPoster({ appId: "123", keyPath, fetch: fakeFetch })(prUrl, findings);
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    "GET https://api.github.com/repos/kirhgoff/widgets/installation",
    "POST https://api.github.com/app/installations/7/access_tokens",
    "POST https://api.github.com/repos/kirhgoff/widgets/pulls/1/reviews",
  ]);
  expect(requests[2]?.auth).toBe("Bearer ghs_x");
  expect(requests[2]?.body).toEqual({ event: "COMMENT", body: "see inline", comments: [{ path: "a.ts", line: 3, body: "bug", side: "RIGHT" }] });
});
