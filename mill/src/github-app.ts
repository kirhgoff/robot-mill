import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { parsePr } from "./github";

export type ReviewInput = { event: "COMMENT" | "REQUEST_CHANGES"; body: string; comments: { path: string; line: number; body: string }[] };

type AppConfig = { appId: string; keyPath: string; fetch?: typeof fetch; now?: () => number };

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signAppJwt(appId: string, privateKey: string, nowMs: number) {
  const seconds = Math.floor(nowMs / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

export function createReviewPoster({ appId, keyPath, fetch: doFetch = fetch, now = Date.now }: AppConfig) {
  async function api(method: string, path: string, token: string, body?: unknown) {
    const response = await doFetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "robot-mill", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`github ${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as any;
  }

  return async function postReview(prUrl: string, review: ReviewInput) {
    const pr = parsePr(prUrl);
    const jwt = signAppJwt(appId, readFileSync(keyPath, "utf8"), now());
    const installation = await api("GET", `/repos/${pr.owner}/${pr.repo}/installation`, jwt);
    const { token } = await api("POST", `/app/installations/${installation.id}/access_tokens`, jwt);
    await api("POST", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, token, {
      event: review.event,
      body: review.body,
      comments: review.comments.map((comment) => ({ ...comment, side: "RIGHT" })),
    });
  };
}
