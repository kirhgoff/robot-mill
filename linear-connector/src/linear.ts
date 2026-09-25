const ENDPOINT = "https://api.linear.app/graphql";

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string;
	labels: string[];
	project: string | null;
	startedAt: string | null;
	url: string;
}

export interface TeamInfo {
	id: string;
	states: { id: string; name: string }[];
}

interface IssueNode {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	startedAt: string | null;
	url: string;
	labels: { nodes: { name: string }[] };
	project: { name: string } | null;
}

const ISSUE_FIELDS = "id identifier title description startedAt url labels { nodes { name } } project { name }";

function toIssue(n: IssueNode): LinearIssue {
	return {
		id: n.id,
		identifier: n.identifier,
		title: n.title,
		description: n.description ?? "",
		labels: n.labels.nodes.map((l) => l.name),
		project: n.project?.name ?? null,
		startedAt: n.startedAt,
		url: n.url,
	};
}

export class LinearClient {
	private apiKey: string;
	private labelCache = new Map<string, string>();

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: this.apiKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) throw new Error(`Linear API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
		if (body.errors?.length) {
			throw new Error(`Linear API: ${body.errors.map((e) => e.message).join("; ")}`);
		}
		if (!body.data) throw new Error("Linear API: empty response");
		return body.data;
	}

	async getTeam(key: string): Promise<TeamInfo> {
		const data = await this.query<{
			teams: { nodes: { id: string; key: string; states: { nodes: { id: string; name: string }[] } }[] };
		}>(`query { teams { nodes { id key states { nodes { id name } } } } }`);
		const team = data.teams.nodes.find((t) => t.key === key);
		if (!team) throw new Error(`Linear team "${key}" not found`);
		return { id: team.id, states: team.states.nodes };
	}

	async ensureState(teamId: string, name: string, color: string): Promise<string> {
		const team = await this.query<{
			team: { states: { nodes: { id: string; name: string }[] } };
		}>(`query($id: String!) { team(id: $id) { states { nodes { id name } } } }`, { id: teamId });
		const existing = team.team.states.nodes.find((s) => s.name === name);
		if (existing) return existing.id;

		const created = await this.query<{
			workflowStateCreate: { workflowState: { id: string } };
		}>(
			`mutation($input: WorkflowStateCreateInput!) {
				workflowStateCreate(input: $input) { workflowState { id } }
			}`,
			{ input: { teamId, name, color, type: "unstarted" } },
		);
		return created.workflowStateCreate.workflowState.id;
	}

	async ensureLabel(teamId: string, name: string): Promise<string> {
		const cacheKey = `${teamId}:${name}`;
		const cached = this.labelCache.get(cacheKey);
		if (cached) return cached;

		const existing = await this.query<{ issueLabels: { nodes: { id: string }[] } }>(
			`query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }`,
			{ name },
		);
		const found = existing.issueLabels.nodes[0];
		if (found) {
			this.labelCache.set(cacheKey, found.id);
			return found.id;
		}

		const created = await this.query<{
			issueLabelCreate: { issueLabel: { id: string } };
		}>(
			`mutation($input: IssueLabelCreateInput!) {
				issueLabelCreate(input: $input) { issueLabel { id } }
			}`,
			{ input: { name, teamId } },
		);
		const id = created.issueLabelCreate.issueLabel.id;
		this.labelCache.set(cacheKey, id);
		return id;
	}

	async addLabel(issueId: string, labelId: string): Promise<void> {
		await this.query(
			`mutation($issueId: String!, $labelId: String!) {
				issueAddLabel(id: $issueId, labelId: $labelId) { success }
			}`,
			{ issueId, labelId },
		);
	}

	async issuesInState(stateId: string): Promise<LinearIssue[]> {
		const data = await this.query<{ issues: { nodes: IssueNode[] } }>(
			`query($id: ID!) {
				issues(filter: { state: { id: { eq: $id } } }, first: 50) {
					nodes { ${ISSUE_FIELDS} }
				}
			}`,
			{ id: stateId },
		);
		return data.issues.nodes.map(toIssue);
	}

	async issuesInStateWithLabel(stateId: string, label: string): Promise<LinearIssue[]> {
		const data = await this.query<{ issues: { nodes: IssueNode[] } }>(
			`query($id: ID!, $label: String!) {
				issues(filter: { state: { id: { eq: $id } }, labels: { name: { eq: $label } } }, first: 50) {
					nodes { ${ISSUE_FIELDS} }
				}
			}`,
			{ id: stateId, label },
		);
		return data.issues.nodes.map(toIssue);
	}

	async createIssue(input: {
		teamId: string;
		title: string;
		description: string;
		stateId: string;
		labelIds: string[];
	}): Promise<{ id: string; identifier: string; url: string }> {
		const data = await this.query<{
			issueCreate: { issue: { id: string; identifier: string; url: string } };
		}>(
			`mutation($input: IssueCreateInput!) {
				issueCreate(input: $input) { issue { id identifier url } }
			}`,
			{ input },
		);
		return data.issueCreate.issue;
	}

	async moveIssue(issueId: string, stateId: string): Promise<void> {
		await this.query(
			`mutation($id: String!, $stateId: String!) {
				issueUpdate(id: $id, input: { stateId: $stateId }) { success }
			}`,
			{ id: issueId, stateId },
		);
	}

	async comment(issueId: string, body: string): Promise<void> {
		await this.query(
			`mutation($id: String!, $body: String!) {
				commentCreate(input: { issueId: $id, body: $body }) { success }
			}`,
			{ id: issueId, body },
		);
	}
}
