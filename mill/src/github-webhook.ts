import { createHmac, timingSafeEqual } from "node:crypto";
import type { Tasks } from "./tasks";

const debounceMs = 3 * 60_000;

type Payload = {
  action?: string;
  sender?: { login?: string };
  pull_request?: { html_url?: string; merged?: boolean };
  issue?: { pull_request?: { html_url?: string } };
};

type Schedule = (fn: () => void, ms: number) => () => void;

export type GithubWebhookDeps = { secret: string; tasks: Tasks; botLogin: string; appLogin: string; schedule?: Schedule };

const reviewActivity: Record<string, string> = {
  pull_request_review: "submitted",
  pull_request_review_comment: "created",
  issue_comment: "created",
};

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

function validSignature(secret: string, raw: string, header: string | null) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createGithubWebhook({ secret, tasks, botLogin, appLogin, schedule = defaultSchedule }: GithubWebhookDeps) {
  const pending = new Map<string, () => void>();

  function debounce(prUrl: string) {
    pending.get(prUrl)?.();
    pending.set(
      prUrl,
      schedule(() => {
        pending.delete(prUrl);
        const build = tasks.findOpenPr(prUrl);
        if (build && !tasks.hasPendingFix(build)) tasks.queueFix(build.id).catch(console.error);
      }, debounceMs),
    );
  }

  return async function handle(request: Request) {
    const raw = await request.text();
    if (!validSignature(secret, raw, request.headers.get("x-hub-signature-256"))) return new Response("unauthorized", { status: 401 });
    const event = request.headers.get("x-github-event") ?? "";
    const payload = JSON.parse(raw) as Payload;
    const prUrl = payload.pull_request?.html_url ?? payload.issue?.pull_request?.html_url;
    const build = prUrl ? tasks.findOpenPr(prUrl) : undefined;
    if (!prUrl || !build) return new Response("ignored");
    if (event === "pull_request" && payload.action === "closed") {
      pending.get(prUrl)?.();
      pending.delete(prUrl);
      await tasks.closePr(build, payload.pull_request?.merged === true);
    } else if (reviewActivity[event] === payload.action && ![botLogin, appLogin].includes(payload.sender?.login ?? "")) {
      debounce(prUrl);
    }
    return new Response("ok");
  };
}
