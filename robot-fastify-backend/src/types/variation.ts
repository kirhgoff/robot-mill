/**
 * Variation types — a variation is a git worktree + agent + dev server.
 */

export type VariationStatus =
	| "creating" // agent is making initial changes
	| "running" // dev server is up
	| "stopped" // dev server is down, worktree still exists
	| "error"; // something went wrong

export type VariationKind = "main" | "variation";

export interface Variation {
	/** Unique variation ID */
	id: string;
	/**
	 * Kind of variation. "main" is the singleton baseline worktree tracking
	 * the source repo's default branch; it cannot be deleted or turned into a
	 * pull request. "variation" is a user-created variation (default).
	 */
	kind: VariationKind;
	/** User-provided title */
	title: string;
	/** Kebab-case slug for directory naming */
	slug: string;
	/** Source repository URL */
	sourceRepo: string;
	/** Current status */
	status: VariationStatus;
	/** Auto-assigned port for the dev server (null if not running) */
	port: number | null;
	/** Linked pi agent session ID */
	agentId: string;
	/** Absolute path to the worktree directory */
	worktreePath: string;
	/** When this variation was created */
	createdAt: number;
	/** When the variation was last modified */
	lastActivityAt: number;
	/** The initial prompt used to create the variation */
	initialPrompt: string;
	/** PID of the dev server process (null if not running) */
	devServerPid: number | null;
	/** The git branch name for this worktree */
	branch: string;
	/** The branch this worktree was created from (default branch if unspecified) */
	baseBranch?: string;
	/** Last error message, if any */
	lastError: string | null;
}

export interface ChatMessage {
	/** "user" | "assistant" | "system" */
	role: "user" | "assistant" | "system";
	/** Message text */
	text: string;
	/** Timestamp (epoch ms) */
	timestamp: number;
}

export interface CreateVariationRequest {
	/** Human-readable title */
	title: string;
	/** Prompt to send to the agent */
	prompt: string;
	/** Override the default source repo */
	sourceRepo?: string;
	/** Base branch to branch from (defaults to the repo's default branch) */
	baseBranch?: string;
}

export interface TargetProjectConfig {
	/** Default source repository URL */
	sourceRepo: string;
	/** Port range for dev servers */
	portRangeMin: number;
	portRangeMax: number;
	/** Base directory for worktrees (inside the container, but bind-mounted) */
	dataDir: string;
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
