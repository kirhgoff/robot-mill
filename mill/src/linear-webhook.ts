import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentType, Store } from "./store";
import type { Tasks } from "./tasks";

const toleranceMs = 60_000;

type Payload = {
  type?: string;
  action?: string;
  url?: string;
  webhookTimestamp?: number;
  updatedFrom?: { stateId?: string };
  data?: {
    identifier?: string;
    title?: string;
    description?: string | null;
    state?: { name?: string };
    project?: { name?: string } | null;
    labels?: { name: string }[];
  };
};

export type LinearWebhookDeps = { secret: string; store: Store; tasks: Tasks; now?: () => number };

function validSignature(secret: string, raw: string, signature: string | null) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function pinnedType(labels: { name: string }[]): AgentType | null {
  const names = labels.map((label) => label.name);
  return names.includes("worker:claude") ? "claude" : names.includes("worker:codex") ? "codex" : null;
}

export function createLinearWebhook({ secret, store, tasks, now = Date.now }: LinearWebhookDeps) {
  return async function handle(request: Request) {
    const raw = await request.text();
    if (!validSignature(secret, raw, request.headers.get("linear-signature"))) return new Response("unauthorized", { status: 401 });
    const payload = JSON.parse(raw) as Payload;
    if (Math.abs(now() - (payload.webhookTimestamp ?? 0)) > toleranceMs) return new Response("unauthorized", { status: 401 });
    const issue = payload.data;
    const movedToQueue =
      payload.type === "Issue" && payload.action === "update" && payload.updatedFrom?.stateId && issue?.state?.name === "Agent Queue";
    if (movedToQueue && issue?.identifier && !store.listTasks().some((task) => task.ticket_id === issue.identifier)) {
      store.insertTask({
        kind: "build",
        title: issue.title ?? issue.identifier,
        description: issue.description ?? "",
        linear_project: issue.project?.name ?? null,
        pinned_type: pinnedType(issue.labels ?? []),
        ticket_id: issue.identifier,
        ticket_url: payload.url ?? null,
      });
      await tasks.tick();
    }
    return new Response("ok");
  };
}
