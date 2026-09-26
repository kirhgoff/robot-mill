export interface LinearTask {
	identifier: string;
	title: string;
	project: string;
	mode: "code" | "ops";
	phase?: "plan" | "execute";
	key: string;
	startedAt: number;
	url: string;
}

export interface LinearClientOptions {
	baseUrl: string;
}

export class LinearClient {
	private baseUrl: string;

	constructor(options: LinearClientOptions) {
		this.baseUrl = options.baseUrl;
	}

	async tasks(): Promise<LinearTask[]> {
		return this.get("/tasks");
	}

	async poll(): Promise<{ ok: boolean; dispatched: number }> {
		return this.post("/poll", {});
	}

	async createTicket(input: {
		project: string;
		title: string;
		description?: string;
		ops?: boolean;
	}): Promise<{ identifier: string; url: string }> {
		return this.post("/tickets", input);
	}

	async abortTask(identifier: string): Promise<{ ok: boolean }> {
		return this.post(`/tasks/${encodeURIComponent(identifier)}/abort`, {});
	}

	private async get<T>(path: string): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`);
		if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
		return res.json() as Promise<T>;
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`POST ${path} failed (${res.status}): ${text}`);
		}
		return res.json() as Promise<T>;
	}
}
