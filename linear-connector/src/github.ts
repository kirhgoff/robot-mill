export async function findPr(repo: string, branch: string, token: string): Promise<string | null> {
	const owner = repo.split("/")[0];
	const res = await fetch(`https://api.github.com/repos/${repo}/pulls?head=${owner}:${branch}&state=all`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "robot-mill",
		},
	});
	if (!res.ok) return null;
	const prs = (await res.json()) as { html_url: string }[];
	return prs[0]?.html_url ?? null;
}
