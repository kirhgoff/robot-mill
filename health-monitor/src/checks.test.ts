import { afterEach, describe, expect, it, mock } from "bun:test";
import { providerCheck } from "./checks";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function installFetch(fetcher: (...args: any[]) => any): void {
	globalThis.fetch = fetcher as unknown as typeof fetch;
}

function response(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("providerCheck", () => {
	it("validates the OpenAI key and checks plan and exec models by ID", async () => {
		const requested: string[] = [];
		installFetch(mock(async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			return response(200, { id: url.split("/").pop() });
		}));

		const verdict = await providerCheck("openai", "secret", "", "gpt-plan", "gpt-exec", 10);

		expect(verdict.status).toBe("ok");
		expect(requested).toContain("https://api.openai.com/v1/models");
		expect(requested).toContain("https://api.openai.com/v1/models/gpt-plan");
		expect(requested).toContain("https://api.openai.com/v1/models/gpt-exec");
	});

	it("reports a missing key without making requests", async () => {
		const fetchMock = mock();
		installFetch(fetchMock);

		const verdict = await providerCheck("openai", "", "", "gpt-plan", "gpt-exec", 10);

		expect(verdict.status).toBe("unknown");
		expect(verdict.detail).toContain("no openai provider key");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires both OpenAI model IDs", async () => {
		const fetchMock = mock();
		installFetch(fetchMock);

		const verdict = await providerCheck("openai", "secret", "", "gpt-plan", "", 10);

		expect(verdict.status).toBe("unknown");
		expect(verdict.detail).toContain("EXEC_MODEL");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports invalid keys and unavailable models", async () => {
		installFetch(mock(async (input: string | URL | Request) =>
			String(input).endsWith("/v1/models") ? response(401) : response(404),
		));
		const invalidKey = await providerCheck("openai", "bad", "", "gpt-plan", "gpt-exec", 10);
		expect(invalidKey.status).toBe("fail");
		expect(invalidKey.detail).toContain("key check returned 401");

		installFetch(mock(async (input: string | URL | Request) =>
			String(input).endsWith("/v1/models") ? response(200) : response(404),
		));
		const missingModel = await providerCheck("openai", "valid", "", "gpt-plan", "gpt-exec", 10);
		expect(missingModel.status).toBe("fail");
		expect(missingModel.detail).toContain("gpt-plan");
	});

	it("uses OpenRouter endpoints only when OpenRouter is selected", async () => {
		const requested: string[] = [];
		installFetch(mock(async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			if (url.endsWith("/credits")) {
				return response(200, { data: { total_credits: 50, total_usage: 5 } });
			}
			return response(200, { data: [{ id: "vendor/model" }] });
		}));

		const openrouter = await providerCheck("openrouter", "or-key", "vendor/model", "", "", 10);
		expect(openrouter.status).toBe("ok");
		expect(requested).toEqual([
			"https://openrouter.ai/api/v1/credits",
			"https://openrouter.ai/api/v1/models",
		]);

		requested.length = 0;
		const anthropic = await providerCheck("anthropic", "anthropic-key", "", "", "", 10);
		expect(anthropic.status).toBe("unknown");
		expect(requested).toHaveLength(0);
	});
});
