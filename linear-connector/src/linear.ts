const ENDPOINT = "https://api.linear.app/graphql";

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string;
	labels: string[];
}

export interface TeamInfo {
	id: string;
	states: { id: string; name: string }[];
}

export class LinearClient {
	private apiKey: string;

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
		}>(
			`query { teams { nodes { id key states { nodes { id name } } } } }`,
		);
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

	async issuesInState(stateId: string): Promise<LinearIssue[]> {
		const data = await this.query<{
			workflowState: {
				issues: {
					nodes: {
						id: string;
						identifier: string;
						title: string;
						description: string | null;
						labels: { nodes: { name: string }[] };
					}[];
				};
			};
		}>(
			`query($id: String!) {
				workflowState(id: $id) {
					issues(filter: { state: { id: { eq: $id } } }) {
						nodes { id identifier title description labels { nodes { name } } }
					}
				}
			}`,
			{ id: stateId },
		);
		return data.workflowState.issues.nodes.map((n) => ({
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			description: n.description ?? "",
			labels: n.labels.nodes.map((l) => l.name),
		}));
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
