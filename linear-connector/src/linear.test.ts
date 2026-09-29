import { expect, test } from "bun:test";
import { LinearClient } from "./linear";

test("LinearClient query rejects when the server does not respond before its timeout", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Promise<Response>(() => {}),
	});

	try {
		const client = new LinearClient("test", `http://127.0.0.1:${server.port}/graphql`, 50);
		const startedAt = Date.now();
		await expect(client.issuesInState("state")).rejects.toMatchObject({ name: "TimeoutError" });
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	} finally {
		server.stop(true);
	}
});
