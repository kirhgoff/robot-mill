/**
 * VariationManager — orchestrates the lifecycle of site variations.
 *
 * Each variation is:
 *   1. A git worktree (created from a bare clone of the source repo)
 *   2. A pi agent session that modifies the worktree
 *   3. A dev server on an auto-assigned port
 *
 * State is persisted to a JSON file so variations survive restarts.
 */

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { Config } from "../../config";
import type { AgentManager } from "../agent-manager/index";
import type {
  Variation,
  CreateVariationRequest,
  TargetProjectConfig,
  VariationDiff,
  DiffFile,
  ChatMessage,
} from "../../types/variation";
import { GitManager } from "./git-manager";
import { PortManager } from "./port-manager";
import { DevServerManager } from "./dev-server";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const AGENT_SYSTEM_PROMPT = `You are modifying a web project inside a git worktree.
Make your changes directly to the files. Commit each logical change with a descriptive message.
Do NOT commit to the master, only to the worktree branch.
Do NOT start a dev server — that is handled automatically by the system.
Do NOT run \`npm install\` or \`bun install\` — dependencies are managed externally.
Focus on the code changes requested by the user.`;

export class VariationManager extends EventEmitter {
  private variations = new Map<string, Variation>();
  private chatMessages = new Map<string, ChatMessage[]>();
  /** Buffer for accumulating streaming text per agent */
  private pendingAssistantText = new Map<string, string>();
  private readonly stateFile: string;
  private readonly targetConfig: TargetProjectConfig;
  private readonly gitManager: GitManager;
  private readonly portManager: PortManager;
  private readonly devServerManager: DevServerManager;
  private readonly agentManager: AgentManager;
  private readonly config: Config;

  constructor(config: Config, agentManager: AgentManager) {
    super();
    this.config = config;
    this.agentManager = agentManager;

    this.targetConfig = {
      sourceRepo:
        process.env.TARGET_SOURCE_REPO ||
        "https://github.com/kirhgoff/vary-workshop.git",
      portRangeMin: Number(process.env.TARGET_PORT_MIN || "4001"),
      portRangeMax: Number(process.env.TARGET_PORT_MAX || "4100"),
      dataDir: resolve(process.env.TARGET_DATA_DIR || join(config.workspace, "target")),
    };

    // Ensure data dir exists
    mkdirSync(this.targetConfig.dataDir, { recursive: true });

    this.stateFile = join(this.targetConfig.dataDir, "variations.json");
    this.gitManager = new GitManager(this.targetConfig.dataDir);
    this.portManager = new PortManager(
      this.targetConfig.portRangeMin,
      this.targetConfig.portRangeMax,
    );
    this.devServerManager = new DevServerManager();

    // Forward dev server events
    this.devServerManager.on("log", (data) => this.emit("devserver:log", data));
    this.devServerManager.on("exit", (data) => {
      this.emit("devserver:exit", data);
      this.onDevServerExit(data.variationId);
    });
    this.devServerManager.on("error", (data) =>
      this.emit("devserver:error", data),
    );

    // Capture agent output as chat messages
    this.setupAgentMessageCapture();

    // Load persisted state
    this.loadState();

    // Ensure the singleton "Main" baseline variation exists. Runs in the
    // background so the constructor stays synchronous; any failure is logged
    // but does not prevent the manager from operating on user variations.
    this.ensureMainVariation().catch((err) => {
      this.emit("variation:error", {
        variationId: "main",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Public API ──────────────────────────────────────────

  /** Create a new variation: clone → worktree → agent → prompt → dev server. */
  async create(request: CreateVariationRequest): Promise<Variation> {
    const id = nanoid(12);
    const slug = slugify(request.title) || id;
    const sourceRepo = request.sourceRepo || this.targetConfig.sourceRepo;

    const variation: Variation = {
      id,
      kind: "variation",
      title: request.title,
      slug,
      sourceRepo,
      status: "creating",
      port: null,
      agentId: id, // Use same ID for agent session
      worktreePath: this.gitManager.getWorktreePath(slug),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      initialPrompt: request.prompt,
      devServerPid: null,
      branch: `variation/${slug}`,
      baseBranch: request.baseBranch,
      lastError: null,
    };

    this.variations.set(id, variation);
    this.saveState();
    this.emit("variation:created", variation);

    // Run creation in background
    this.runCreation(variation).catch((err) => {
      variation.status = "error";
      variation.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      this.emit("variation:error", {
        variationId: id,
        error: variation.lastError,
      });
    });

    return variation;
  }

  /** Start the dev server for a stopped variation. */
  async startServer(variationId: string): Promise<Variation> {
    const variation = this.getVariation(variationId);

    if (variation.status === "running") {
      throw new Error(`Variation "${variationId}" is already running`);
    }

    const port = await this.portManager.findFree();
    this.portManager.reserve(port);

    await this.devServerManager.start(
      variationId,
      variation.worktreePath,
      port,
    );

    variation.port = port;
    variation.status = "running";
    variation.devServerPid = this.devServerManager.getPid(variationId);
    variation.lastActivityAt = Date.now();
    this.saveState();
    this.emit("variation:started", variation);

    return variation;
  }

  /** Stop the dev server for a running variation. */
  stopServer(variationId: string): Variation {
    const variation = this.getVariation(variationId);

    this.devServerManager.stop(variationId);

    if (variation.port) {
      this.portManager.release(variation.port);
    }

    variation.port = null;
    variation.status = "stopped";
    variation.devServerPid = null;
    variation.lastActivityAt = Date.now();
    this.saveState();
    this.emit("variation:stopped", variation);

    return variation;
  }

  /** Push branch, open a GitHub PR, then remove the worktree. Returns the PR URL. */
  async createPullRequest(variationId: string): Promise<string> {
    const variation = this.getVariation(variationId);

    if (variation.kind === "main") {
      throw new Error("Cannot create a pull request for the Main variation");
    }

    // Stop dev server if running
    if (variation.status === "running") {
      this.stopServer(variationId);
    }

    // Kill the agent if alive
    try {
      this.agentManager.kill(variationId);
    } catch {
      // Agent may not exist
    }

    // Push + open PR
    const prUrl = await this.gitManager.createPullRequest(
      variation.slug,
      variation.title,
    );

    // Remove worktree
    try {
      await this.gitManager.removeWorktree(variation.slug);
    } catch {
      // Best-effort
    }

    this.variations.delete(variationId);
    this.saveState();
    this.emit("variation:deleted", { variationId });

    return prUrl;
  }

  /** Delete a variation: stop server, kill agent, remove worktree. */
  async delete(variationId: string): Promise<void> {
    const variation = this.variations.get(variationId);
    if (!variation) return;

    if (variation.kind === "main") {
      throw new Error("Cannot delete the Main variation");
    }

    // Stop dev server
    this.devServerManager.stop(variationId);
    if (variation.port) {
      this.portManager.release(variation.port);
    }

    // Kill the agent if alive
    try {
      this.agentManager.kill(variationId);
    } catch {
      // Agent may not exist
    }

    // Remove worktree
    try {
      await this.gitManager.removeWorktree(variation.slug);
    } catch {
      // Worktree may not exist
    }

    this.variations.delete(variationId);
    this.saveState();
    this.emit("variation:deleted", { variationId });
  }

  /** Send a chat message to the variation's agent. Resume session if needed. */
  async chat(variationId: string, message: string): Promise<void> {
    const variation = this.getVariation(variationId);

    // Store the user message
    this.addMessage(variationId, { role: "user", text: message, timestamp: Date.now() });

    // Check if agent is alive; if not, respawn with session resume
    try {
      this.agentManager.getAgentInfo(variation.agentId);
    } catch {
      // Agent is not running — respawn with session resume
      this.agentManager.spawn({
        name: `variation-${variation.slug}`,
        sessionId: variation.agentId,
        cwd: variation.worktreePath,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        resumeSession: true,
      });
    }

    this.agentManager.prompt(variation.agentId, message);
    variation.lastActivityAt = Date.now();
    this.saveState();
  }

  /** Get chat messages for a variation. */
  getMessages(variationId: string): ChatMessage[] {
    this.getVariation(variationId); // ensure variation exists
    return this.chatMessages.get(variationId) || [];
  }

  /** Get a single variation. */
  get(variationId: string): Variation {
    return this.getVariation(variationId);
  }

  /** List all variations. Main is always pinned first. */
  list(): Variation[] {
    return Array.from(this.variations.values()).sort((a, b) => {
      if (a.kind === "main" && b.kind !== "main") return -1;
      if (b.kind === "main" && a.kind !== "main") return 1;
      return b.createdAt - a.createdAt;
    });
  }

  /**
   * Refresh the Main baseline variation: fetch origin, hard-reset the
   * worktree to the default branch, and wipe untracked files. Restarts the
   * dev server if it was running. Only works on kind="main".
   */
  async refreshMain(variationId: string): Promise<Variation> {
    const variation = this.getVariation(variationId);
    if (variation.kind !== "main") {
      throw new Error("Refresh is only supported for the Main variation");
    }

    const wasRunning = variation.status === "running";
    if (wasRunning) {
      this.stopServer(variationId);
    }

    await this.gitManager.refreshBaselineWorktree(variation.slug);

    variation.lastActivityAt = Date.now();
    variation.lastError = null;
    this.saveState();
    this.emit("variation:refreshed", variation);

    if (wasRunning) {
      await this.startServer(variationId);
    }

    return this.getVariation(variationId);
  }

  /**
   * Ensure the singleton Main baseline variation exists. Called once during
   * construction. Idempotent: if a main variation is already persisted the
   * method only reconciles the worktree path / makes sure the worktree
   * exists on disk.
   */
  private async ensureMainVariation(): Promise<void> {
    // Make sure the bare clone is present and up to date before we try to
    // create the worktree.
    await this.gitManager.ensureBareClone(this.targetConfig.sourceRepo);

    const existing = Array.from(this.variations.values()).find(
      (v) => v.kind === "main",
    );

    if (existing) {
      // Make sure the worktree directory is actually present (the bare clone
      // or worktrees dir may have been wiped between runs).
      await this.gitManager.ensureBaselineWorktree(existing.slug);
      return;
    }

    const slug = "main";
    await this.gitManager.ensureBaselineWorktree(slug);

    const mainVariation: Variation = {
      id: "main",
      kind: "main",
      title: "Main",
      slug,
      sourceRepo: this.targetConfig.sourceRepo,
      status: "stopped",
      port: null,
      // Main has no agent; use the id slot for symmetry but never spawn one.
      agentId: "main",
      worktreePath: this.gitManager.getWorktreePath(slug),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      initialPrompt: "",
      devServerPid: null,
      branch: `baseline/${slug}`,
      baseBranch: undefined,
      lastError: null,
    };

    this.variations.set(mainVariation.id, mainVariation);
    this.saveState();
    this.emit("variation:created", mainVariation);
  }

  /** Get the git diff for a variation. */
  async getDiff(variationId: string): Promise<VariationDiff> {
    const variation = this.getVariation(variationId);
    const rawDiff = await this.gitManager.getDiff(variation.slug);

    const files = this.parseDiff(rawDiff);
    const summary = {
      added: files.filter((f) => f.status === "added").length,
      modified: files.filter((f) => f.status === "modified").length,
      deleted: files.filter((f) => f.status === "deleted").length,
    };

    return { variationId, files, summary };
  }

  /** Get the git log for a variation. */
  async getLog(variationId: string): Promise<string> {
    const variation = this.getVariation(variationId);
    return this.gitManager.getLog(variation.slug);
  }

  /** Get changed file count for a variation. */
  async getChangedFiles(variationId: string): Promise<string[]> {
    const variation = this.getVariation(variationId);
    return this.gitManager.getChangedFiles(variation.slug);
  }

  /** Fetch the latest commits from origin into the bare clone. */
  async refreshSource(): Promise<void> {
    await this.gitManager.ensureBareClone(this.targetConfig.sourceRepo);
    await this.gitManager.fetchLatest();
  }

  /** List branches available in the source repo (for choosing a base branch). */
  async listBranches(): Promise<string[]> {
    await this.gitManager.ensureBareClone(this.targetConfig.sourceRepo);
    return this.gitManager.listBranches();
  }

  /** Get the current target project configuration. */
  getConfig(): TargetProjectConfig {
    return { ...this.targetConfig };
  }

  /** Update the source repo and persist. */
  updateConfig(updates: Partial<TargetProjectConfig>): TargetProjectConfig {
    if (updates.sourceRepo) this.targetConfig.sourceRepo = updates.sourceRepo;
    if (updates.portRangeMin)
      this.targetConfig.portRangeMin = updates.portRangeMin;
    if (updates.portRangeMax)
      this.targetConfig.portRangeMax = updates.portRangeMax;
    this.saveState();
    return this.getConfig();
  }

  /** Stop all dev servers (for graceful shutdown). */
  shutdown(): void {
    this.devServerManager.stopAll();
  }

  // ── Private ──────────────────────────────────────────

  /** Add a message to a variation's chat history and persist. */
  private addMessage(variationId: string, msg: ChatMessage): void {
    if (!this.chatMessages.has(variationId)) {
      this.chatMessages.set(variationId, []);
    }
    this.chatMessages.get(variationId)!.push(msg);
    this.saveState();
  }

  /** Find the variation ID for an agent ID. */
  private findVariationByAgentId(agentId: string): string | null {
    for (const [, v] of this.variations) {
      if (v.agentId === agentId) return v.id;
    }
    return null;
  }

  /** Listen to agent manager events and record messages. */
  private setupAgentMessageCapture(): void {
    // Accumulate streaming text deltas
    this.agentManager.on("agent:output", (output: { agentId: string; type: string; data: unknown }) => {
      const variationId = this.findVariationByAgentId(output.agentId);
      if (!variationId) return;

      if (output.type === "text") {
        const current = this.pendingAssistantText.get(output.agentId) || "";
        this.pendingAssistantText.set(output.agentId, current + (output.data as string));
      } else if (output.type === "tool_start") {
        const data = output.data as { toolName?: string };
        this.addMessage(variationId, {
          role: "system",
          text: `\uD83D\uDD27 Running: ${data.toolName || "tool"}`,
          timestamp: Date.now(),
        });
      }
    });

    // When agent finishes a complete message, store it
    this.agentManager.on("agent:message_complete", (event: { agentId: string; text: string }) => {
      const variationId = this.findVariationByAgentId(event.agentId);
      if (!variationId) return;

      const text = this.pendingAssistantText.get(event.agentId)?.trim() || event.text;
      this.pendingAssistantText.delete(event.agentId);

      if (text) {
        this.addMessage(variationId, {
          role: "assistant",
          text,
          timestamp: Date.now(),
        });
      }
    });
  }

  private async runCreation(variation: Variation): Promise<void> {
    // Store the initial user prompt as the first message
    this.addMessage(variation.id, {
      role: "user",
      text: variation.initialPrompt,
      timestamp: variation.createdAt,
    });

    // 1. Ensure bare clone exists and is up to date (always fetches before
    //    creating a worktree so new variations pick up the latest commits)
    await this.gitManager.ensureBareClone(variation.sourceRepo);

    // 2. Create worktree based on the requested base branch (or default)
    await this.gitManager.createWorktree(variation.slug, variation.baseBranch);

    // 3. Spawn pi agent
    this.agentManager.spawn({
      name: `variation-${variation.slug}`,
      sessionId: variation.agentId,
      cwd: variation.worktreePath,
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    // 4. Send the initial prompt
    this.agentManager.prompt(variation.agentId, variation.initialPrompt);

    // 5. Wait for agent to finish the initial prompt, then start server
    this.waitForAgentIdle(variation);
  }

  private waitForAgentIdle(variation: Variation): void {
    const onOutput = (output: {
      agentId: string;
      type: string;
      data: unknown;
    }) => {
      if (output.agentId !== variation.agentId) return;

      if (
        output.type === "status_change" &&
        (output.data as { status: string }).status === "idle"
      ) {
        this.agentManager.removeListener("agent:output", onOutput);
        this.agentManager.removeListener("agent:error", onError);
        // Agent is done — start the dev server
        this.startServer(variation.id).catch((err) => {
          variation.status = "error";
          variation.lastError =
            err instanceof Error ? err.message : String(err);
          this.saveState();
        });
      }
    };

    const onError = (event: { agentId: string; error: string }) => {
      if (event.agentId !== variation.agentId) return;
      this.agentManager.removeListener("agent:output", onOutput);
      this.agentManager.removeListener("agent:error", onError);
      variation.status = "error";
      variation.lastError = event.error;
      this.saveState();
    };

    this.agentManager.on("agent:output", onOutput);
    this.agentManager.on("agent:error", onError);
  }

  private onDevServerExit(variationId: string): void {
    const variation = this.variations.get(variationId);
    if (!variation) return;

    if (variation.port) {
      this.portManager.release(variation.port);
    }
    variation.port = null;
    variation.status = "stopped";
    variation.devServerPid = null;
    this.saveState();
  }

  private getVariation(variationId: string): Variation {
    const v = this.variations.get(variationId);
    if (!v) throw new Error(`Variation "${variationId}" not found`);
    return v;
  }

  // ── Persistence ──────────────────────────────────────

  private saveState(): void {
    const chatMessagesObj: Record<string, ChatMessage[]> = {};
    for (const [id, msgs] of this.chatMessages) {
      chatMessagesObj[id] = msgs;
    }
    const state = {
      config: this.targetConfig,
      variations: Array.from(this.variations.values()),
      chatMessages: chatMessagesObj,
    };
    try {
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal
    }
  }

  private loadState(): void {
    if (!existsSync(this.stateFile)) return;

    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const state = JSON.parse(raw);

      // Restore config
      if (state.config) {
        if (state.config.sourceRepo)
          this.targetConfig.sourceRepo = state.config.sourceRepo;
        if (state.config.portRangeMin)
          this.targetConfig.portRangeMin = state.config.portRangeMin;
        if (state.config.portRangeMax)
          this.targetConfig.portRangeMax = state.config.portRangeMax;
      }

      // Restore variations (mark all as stopped since servers aren't running)
      if (Array.isArray(state.variations)) {
        for (const v of state.variations as Variation[]) {
          v.status = "stopped";
          v.port = null;
          v.devServerPid = null;
          // Backwards compat: older state files have no `kind` field.
          if (!v.kind) v.kind = "variation";
          this.variations.set(v.id, v);
        }
      }

      // Restore chat messages
      if (state.chatMessages && typeof state.chatMessages === "object") {
        for (const [id, msgs] of Object.entries(state.chatMessages)) {
          if (Array.isArray(msgs)) {
            this.chatMessages.set(id, msgs as ChatMessage[]);
          }
        }
      }
    } catch {
      // Corrupted state file — start fresh
    }
  }

  // ── Diff parsing ─────────────────────────────────────

  private parseDiff(rawDiff: string): DiffFile[] {
    if (!rawDiff.trim()) return [];

    const files: DiffFile[] = [];
    const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
      const lines = section.split("\n");
      const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
      if (!headerMatch) continue;

      const filePath = headerMatch[2];
      let status: DiffFile["status"] = "modified";
      let additions = 0;
      let deletions = 0;

      for (const line of lines) {
        if (line.startsWith("new file")) status = "added";
        else if (line.startsWith("deleted file")) status = "deleted";
        else if (line.startsWith("rename")) status = "renamed";
        else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }

      files.push({
        path: filePath,
        status,
        additions,
        deletions,
        patch: `diff --git ${section}`,
      });
    }

    return files;
  }
}
