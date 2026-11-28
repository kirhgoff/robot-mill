import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearTracker } from "./linear";
import type { AgentType, Store } from "./store";
import type { Tasks } from "./tasks";

const toleranceMs = 60_000;

type Payload = {
  type?: string;
  action?: string;
  webhookTimestamp?: number;
  updatedFrom?: { stateId?: string };
  data?: { id?: string };
};

export type LinearWebhookDeps = { secret: string; store: Store; tasks: Tasks; linear: LinearTracker; now?: () => number };

function validSignature(secret: string, raw: string, signature: string | null) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function pinnedType(names: string[]): AgentType | null {
  return names.includes("worker:claude") ? "claude" : names.includes("worker:codex") ? "codex" : null;
}

export function createLinearWebhook({ secret, store, tasks, linear, now = Date.now }: LinearWebhookDeps) {
  return async function handle(request: Request) {
    const raw = await request.text();
    if (!validSignature(secret, raw, request.headers.get("linear-signature"))) return new Response("unauthorized", { status: 401 });
    const payload = JSON.parse(raw) as Payload;
    if (Math.abs(now() - (payload.webhookTimestamp ?? 0)) > toleranceMs) return new Response("unauthorized", { status: 401 });
    const moved = payload.type === "Issue" && payload.action === "update" && payload.updatedFrom?.stateId && payload.data?.id;
    if (moved) {
      const issue = await linear.issue(payload.data?.id as string);
      if (issue.state === "Agent Queue" && !store.listTasks().some((task) => task.ticket_id === issue.identifier)) {
        store.insertTask({
          kind: "build",
          title: issue.title,
          description: issue.description,
          linear_project: issue.project,
          pinned_type: pinnedType(issue.labels),
          ticket_id: issue.identifier,
          ticket_url: issue.url,
        });
        await tasks.tick();
      }
    }
    return new Response("ok");
  };
}
