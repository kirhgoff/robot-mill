/**
 * Typed REST client for the backend API.
 */

const BASE = "/api";

export type VariationKind = "main" | "variation";

export interface Variation {
	id: string;
	/**
	 * "main" is the singleton baseline tracking the default branch; it cannot
	 * be deleted or turned into a PR. "variation" is a regular user variation.
	 */
	kind: VariationKind;
	title: string;
	slug: string;
	sourceRepo: string;
	status: "creating" | "running" | "stopped" | "error";
	port: number | null;
	agentId: string;
	worktreePath: string;
	createdAt: number;
	lastActivityAt: number;
	initialPrompt: string;
	devServerPid: number | null;
	branch: string;
	baseBranch?: string;
	lastError: string | null;
	changedFileCount?: number;
	changedFiles?: string[];
}

export interface VariationDiff {
	variationId: string;
	files: DiffFile[];
	summary: { added: number; modified: number; deleted: number };
}

export interface DiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	patch: string;
}

export interface TargetProjectConfig {
	sourceRepo: string;
	portRangeMin: number;
	portRangeMax: number;
	dataDir: string;
}

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	text: string;
	timestamp: number;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const hasBody = options?.body !== undefined;
	const res = await fetch(`${BASE}${path}`, {
		...options,
		headers: {
			...(hasBody ? { "Content-Type": "application/json" } : {}),
			...options?.headers,
		},
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
	}
	return res.json();
}

export const api = {
	// Variations
	listVariations: () => request<Variation[]>("/variations"),

	getVariation: (id: string) => request<Variation>(`/variations/${id}`),

	createVariation: (data: {
		title: string;
		prompt: string;
		sourceRepo?: string;
		baseBranch?: string;
	}) =>
		request<Variation>("/variations", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	deleteVariation: (id: string) =>
		request<{ ok: boolean }>(`/variations/${id}`, { method: "DELETE" }),

	startServer: (id: string) =>
		request<Variation>(`/variations/${id}/start`, { method: "POST" }),

	stopServer: (id: string) =>
		request<Variation>(`/variations/${id}/stop`, { method: "POST" }),

	refreshVariation: (id: string) =>
		request<Variation>(`/variations/${id}/refresh`, { method: "POST" }),

	chat: (id: string, message: string) =>
		request<{ ok: boolean }>(`/variations/${id}/chat`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),

	getDiff: (id: string) => request<VariationDiff>(`/variations/${id}/diff`),

	getLog: (id: string) => request<{ log: string }>(`/variations/${id}/log`),

	getChangedFiles: (id: string) =>
		request<{ files: string[] }>(`/variations/${id}/files`),

	getMessages: (id: string) =>
		request<{ messages: ChatMessage[] }>(`/variations/${id}/messages`),

	createPullRequest: (id: string) =>
		request<{ ok: boolean; url: string }>(`/variations/${id}/pull-request`, {
			method: "POST",
		}),

	// Config
	getConfig: () => request<TargetProjectConfig>("/target/config"),

	updateConfig: (data: Partial<TargetProjectConfig>) =>
		request<TargetProjectConfig>("/target/config", {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	// Source repo
	refreshSource: () =>
		request<{ ok: boolean }>("/target/refresh", { method: "POST" }),

	listBranches: () => request<{ branches: string[] }>("/target/branches"),
};
