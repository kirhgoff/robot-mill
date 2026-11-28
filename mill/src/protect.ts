import { type Gh, owner } from "./github";

const rulesetName = "robot-mill-guard";

const ruleset = {
  name: rulesetName,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  rules: [
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
};

export function createCheckRepo(gh: Gh) {
  return async function checkRepo(repo: string) {
    const invitations: { id: number; repository: { full_name: string } }[] = await gh("GET", "user/repository_invitations");
    const invitation = invitations.find((candidate) => candidate.repository.full_name === `${owner}/${repo}`);
    if (invitation) await gh("PATCH", `user/repository_invitations/${invitation.id}`);
    const { default_branch } = await gh("GET", `repos/${owner}/${repo}`);
    const rules: { type: string; parameters?: { required_approving_review_count?: number } }[] = await gh("GET", `repos/${owner}/${repo}/rules/branches/${default_branch}`);
    const guarded = rules.some((rule) => rule.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) >= 1);
    if (!guarded) throw new Error(`${repo} requires an approving review on ${default_branch}. Run: mill protect ${repo}`);
  };
}

export async function protectRepo(gh: Gh, repo: string, botLogin: string) {
  const existing: { id: number; name: string }[] = await gh("GET", `repos/${owner}/${repo}/rulesets`);
  const current = existing.find((candidate) => candidate.name === rulesetName);
  if (current) await gh("PUT", `repos/${owner}/${repo}/rulesets/${current.id}`, ruleset);
  else await gh("POST", `repos/${owner}/${repo}/rulesets`, ruleset);
  await gh("PUT", `repos/${owner}/${repo}/collaborators/${botLogin}`, { permission: "push" });
}

export async function linearRepos(gh: Gh, projects: string[]) {
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const project of projects) {
    const found = await gh("GET", `repos/${owner}/${project}`).then(
      () => true,
      () => false,
    );
    (found ? mapped : unmapped).push(project);
  }
  return { mapped, unmapped };
}
