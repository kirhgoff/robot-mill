import type { Tracker } from "./tracker";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ json(): Promise<unknown> }>;

export type LinearConfig = { apiKey: string; team?: string; fetch?: Fetch };

type LinearIssue = { identifier: string; url: string; title: string; description: string; state: string; project: string | null; labels: string[] };

type RawIssue = {
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string };
  project: { name: string } | null;
  labels: { nodes: { name: string }[] };
};

const issueFields = "identifier url title description state { name } project { name } labels { nodes { name } }";

function toIssue(issue: RawIssue): LinearIssue {
  return {
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    description: issue.description ?? "",
    state: issue.state.name,
    project: issue.project?.name ?? null,
    labels: issue.labels.nodes.map((label) => label.name),
  };
}

export type LinearTracker = Tracker & { issue(id: string): Promise<LinearIssue>; agentQueueIssues(): Promise<LinearIssue[]>; projects(): Promise<string[]> };

export function createLinearTracker(config: LinearConfig): LinearTracker {
  const doFetch = config.fetch ?? (fetch as Fetch);
  const teamKey = config.team ?? "KIR";

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await doFetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: config.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (result.errors?.length || !result.data) throw new Error(`linear: ${result.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    return result.data;
  }

  type Named = { id: string; name: string };
  type Ids = { viewer: string; team: string; states: Named[]; projects: Named[] };
  let ids: Promise<Ids> | null = null;

  function resolve() {
    ids ??= graphql<{ viewer: { id: string }; teams: { nodes: { id: string; states: { nodes: Named[] }; projects: { nodes: Named[] } }[] } }>(
      `query($key: String!) { viewer { id } teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id name } } projects { nodes { id name } } } } }`,
      { key: teamKey },
    ).then((data) => {
      const team = data.teams.nodes[0];
      if (!team) throw new Error(`linear: no team with key ${teamKey}`);
      return { viewer: data.viewer.id, team: team.id, states: team.states.nodes, projects: team.projects.nodes };
    });
    ids.catch(() => (ids = null));
    return ids;
  }

  async function stateId(name: string) {
    const found = (await resolve()).states.find((state) => state.name === name);
    if (!found) throw new Error(`linear: unknown state ${name}`);
    return found.id;
  }

  return {
    async create({ title, description, project }) {
      const known = await resolve();
      const match = known.projects.find((candidate) => candidate.name === project);
      if (!match) throw new Error(`unknown Linear project "${project}"; valid projects: ${known.projects.map((p) => p.name).join(", ")}`);
      const data = await graphql<{ issueCreate: { issue: { identifier: string; url: string } } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
        { input: { teamId: known.team, title, description, projectId: match.id, assigneeId: known.viewer, stateId: await stateId("Agent Queue") } },
      );
      return { id: data.issueCreate.issue.identifier, url: data.issueCreate.issue.url };
    },
    async move(identifier, state) {
      await graphql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
        id: identifier,
        input: { stateId: await stateId(state) },
      });
    },
    async comment(identifier, body) {
      const issue = await graphql<{ issue: { id: string } }>(`query($id: String!) { issue(id: $id) { id } }`, { id: identifier });
      await graphql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId: issue.issue.id, body } });
    },
    async issue(id) {
      const data = await graphql<{ issue: RawIssue }>(`query($id: String!) { issue(id: $id) { ${issueFields} } }`, { id });
      return toIssue(data.issue);
    },
    async projects() {
      return (await resolve()).projects.map((project) => project.name);
    },
    async agentQueueIssues() {
      const data = await graphql<{ issues: { nodes: RawIssue[] } }>(
        `query($key: String!) { issues(filter: { team: { key: { eq: $key } }, state: { name: { eq: "Agent Queue" } } }) { nodes { ${issueFields} } } }`,
        { key: teamKey },
      );
      return data.issues.nodes.map(toIssue);
    },
  };
}
