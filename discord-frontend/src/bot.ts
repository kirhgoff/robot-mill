import { Client, GatewayIntentBits, Partials } from "discord.js";
import pino from "pino";
import { BackendClient, type AgentInfo } from "./backend-client";
import { HostRunnerClient } from "./host-runner-client";

const DISCORD_MAX_LEN = 1900;

export interface DiscordBotOptions {
	botToken: string;
	allowedChannelIds: string[];
	commandPrefix: string;
	backendBaseUrl: string;
	backendWsUrl: string;
	hostRunnerBaseUrl: string;
	hostRunnerWsUrl: string;
	workspace: string;
	piProvider?: string;
	piModel?: string;
}

interface Sendable {
	send: (content: string) => Promise<unknown>;
}

export class DiscordBot {
	private client: Client;
	private backend: BackendClient;
	private hostClient: HostRunnerClient;
	private opts: DiscordBotOptions;
	private log = pino({ name: "discord-bot" });

	private channelAgents = new Map<string, string>();
	private channelProject = new Map<string, string>();

	constructor(opts: DiscordBotOptions) {
		this.opts = opts;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel],
		});
		this.backend = new BackendClient({
			baseUrl: opts.backendBaseUrl,
			wsUrl: opts.backendWsUrl,
		});
		this.hostClient = new HostRunnerClient({
			baseUrl: opts.hostRunnerBaseUrl,
			wsUrl: opts.hostRunnerWsUrl,
		});

		this.setupMessageHandler();
		this.setupWsHandlers();
		this.setupHostWsHandlers();
	}

	async start(): Promise<void> {
		this.backend.connect();
		this.hostClient.connect();
		await this.client.login(this.opts.botToken);
		this.log.info("Discord bot running");
	}

	stop(): void {
		this.backend.disconnect();
		this.hostClient.disconnect();
		void this.client.destroy();
	}

	private setupMessageHandler(): void {
		this.client.on("messageCreate", async (msg) => {
			if (msg.author.bot) return;
			const channelId = msg.channelId;
			if (!this.isAllowed(channelId)) return;

			const content = msg.content.trim();
			if (content.startsWith(this.opts.commandPrefix)) {
				const withoutPrefix = content
					.slice(this.opts.commandPrefix.length)
					.trim();
				const [command, ...rest] = withoutPrefix.split(/\s+/);
				await this.handleCommand(
					channelId,
					command.toLowerCase(),
					rest.join(" "),
				);
				return;
			}
			await this.forwardPrompt(channelId, content);
		});
	}

	private async handleCommand(
		channelId: string,
		command: string,
		arg: string,
	): Promise<void> {
		switch (command) {
			case "start":
				return this.cmdStart(channelId);
			case "stop":
				return this.cmdStop(channelId);
			case "new":
				return this.cmdNew(channelId);
			case "abort":
				return this.cmdAbort(channelId);
			case "status":
				return this.cmdStatus(channelId);
			case "system":
				return this.cmdSystem(channelId);
			case "project":
				return this.cmdProject(channelId, arg.trim());
			case "repo":
				return this.cmdRepo(channelId, arg.trim());
			case "local":
				return this.cmdLocal(channelId);
			default:
				await this.send(
					channelId,
					`Unknown command: \`${command}\`. Try \`${this.opts.commandPrefix}start\`.`,
				);
		}
	}

	private async cmdStart(channelId: string): Promise<void> {
		const existing = this.channelAgents.get(channelId);
		if (existing) {
			try {
				await this.backend.killAgent(existing);
			} catch {
				// ignore
			}
		}
		try {
			const agent = await this.backend.spawnAgent({
				name: `dc-${channelId}`,
				cwd: this.opts.workspace,
				provider: this.opts.piProvider,
				model: this.opts.piModel,
				sessionId: `dc-${channelId}`,
				resumeSession: true,
			});
			this.channelAgents.set(channelId, agent.id);
			this.backend.subscribe(agent.id);
			await this.send(
				channelId,
				[
					"🟢 **Agent session started.** Just send prompts.",
					`\`${this.opts.commandPrefix}project <name>\` — host project · \`${this.opts.commandPrefix}repo <owner/name>\` — clone a repo`,
					`\`${this.opts.commandPrefix}status\` · \`${this.opts.commandPrefix}system\` · \`${this.opts.commandPrefix}stop\``,
				].join("\n"),
			);
		} catch (err) {
			await this.send(channelId, `❌ Failed to start agent: ${errMsg(err)}`);
		}
	}

	private async cmdStop(channelId: string): Promise<void> {
		const agentId = this.channelAgents.get(channelId);
		if (!agentId) return void this.send(channelId, "No active session.");
		try {
			await this.backend.killAgent(agentId);
		} catch {
			// ignore
		}
		this.channelAgents.delete(channelId);
		await this.send(channelId, "🔴 Session stopped.");
	}

	private async cmdNew(channelId: string): Promise<void> {
		const agentId = this.channelAgents.get(channelId);
		if (!agentId) return void this.send(channelId, "No active session.");
		try {
			await this.backend.newSession(agentId);
			await this.send(channelId, "🔄 Fresh conversation started.");
		} catch {
			await this.send(channelId, "❌ Failed to reset session.");
		}
	}

	private async cmdAbort(channelId: string): Promise<void> {
		const agentId = this.channelAgents.get(channelId);
		if (!agentId) return void this.send(channelId, "No active session.");
		try {
			await this.backend.abortAgent(agentId);
			await this.send(channelId, "⛔ Sent abort signal.");
		} catch {
			await this.send(channelId, "❌ Failed to abort.");
		}
	}

	private async cmdStatus(channelId: string): Promise<void> {
		const project = this.channelProject.get(channelId);
		if (project)
			return void this.send(
				channelId,
				`🗂️ Working in host project **${project}**.`,
			);
		const agentId = this.channelAgents.get(channelId);
		if (!agentId) return void this.send(channelId, "🔴 No active session.");
		try {
			const info = await this.backend.getAgent(agentId);
			await this.send(
				channelId,
				`🟢 Session active · ${info.status}\nWorkdir: \`${info.cwd}\``,
			);
		} catch {
			await this.send(channelId, "🔴 Agent not found.");
			this.channelAgents.delete(channelId);
		}
	}

	private async cmdSystem(channelId: string): Promise<void> {
		try {
			const status = await this.backend.getStatus();
			const lines = status.agents.map(
				(a: AgentInfo) =>
					`• \`${a.name}\` (${a.status}) — ${a.currentTask || "idle"}`,
			);
			await this.send(
				channelId,
				[`⚙️ **System Status**`, `Agents: ${status.agentCount}`, ...lines].join(
					"\n",
				),
			);
		} catch (err) {
			await this.send(channelId, `❌ Backend error: ${errMsg(err)}`);
		}
	}

	private async cmdProject(channelId: string, name: string): Promise<void> {
		let allowed: string[] = [];
		try {
			allowed = (await this.hostClient.listProjects()).allowed;
		} catch (err) {
			return void this.send(
				channelId,
				`❌ Host runner unreachable: ${errMsg(err)}`,
			);
		}
		if (!name) {
			return void this.send(
				channelId,
				[`**Host projects:**`, ...allowed.map((p) => `• \`${p}\``)].join("\n"),
			);
		}
		if (!allowed.includes(name)) {
			return void this.send(
				channelId,
				`❌ Unknown project "${name}". Allowed: ${allowed.join(", ")}`,
			);
		}
		this.channelProject.set(channelId, name);
		await this.send(channelId, `🗂️ Now working in host project **${name}**.`);
	}

	private async cmdRepo(channelId: string, arg: string): Promise<void> {
		if (!arg)
			return void this.send(
				channelId,
				`Usage: \`${this.opts.commandPrefix}repo owner/name\``,
			);
		await this.send(channelId, `📦 Cloning \`${arg}\`…`);
		let cloned: { name: string; path: string };
		try {
			cloned = await this.backend.cloneRepo(arg);
		} catch (err) {
			return void this.send(channelId, `❌ Clone failed: ${errMsg(err)}`);
		}
		this.channelProject.delete(channelId);
		const existing = this.channelAgents.get(channelId);
		if (existing) {
			try {
				await this.backend.killAgent(existing);
			} catch {
				// ignore
			}
		}
		try {
			const agent = await this.backend.spawnAgent({
				name: `dc-${channelId}`,
				cwd: cloned.path,
				provider: this.opts.piProvider,
				model: this.opts.piModel,
				sessionId: `dc-${channelId}`,
				resumeSession: false,
			});
			this.channelAgents.set(channelId, agent.id);
			this.backend.subscribe(agent.id);
			await this.send(
				channelId,
				`✅ Working in **${cloned.name}**. It can branch, commit, and open PRs.`,
			);
		} catch (err) {
			await this.send(channelId, `❌ Failed to start agent: ${errMsg(err)}`);
		}
	}

	private async cmdLocal(channelId: string): Promise<void> {
		if (this.channelProject.delete(channelId)) {
			await this.send(channelId, "💻 Switched back to the workspace agent.");
		} else {
			await this.send(channelId, "Already on the workspace agent.");
		}
	}

	private async forwardPrompt(channelId: string, text: string): Promise<void> {
		if (!text) return;
		const project = this.channelProject.get(channelId);
		if (project) {
			try {
				await this.hostClient.prompt(project, text);
			} catch (err) {
				await this.send(
					channelId,
					`❌ Prompt to ${project} failed: ${errMsg(err)}`,
				);
			}
			return;
		}

		let agentId = this.channelAgents.get(channelId);
		if (!agentId) {
			try {
				const agent = await this.backend.spawnAgent({
					name: `dc-${channelId}`,
					cwd: this.opts.workspace,
					provider: this.opts.piProvider,
					model: this.opts.piModel,
					sessionId: `dc-${channelId}`,
					resumeSession: true,
				});
				agentId = agent.id;
				this.channelAgents.set(channelId, agentId);
				this.backend.subscribe(agentId);
				await new Promise((r) => setTimeout(r, 300));
			} catch (err) {
				return void this.send(
					channelId,
					`❌ Could not start agent: ${errMsg(err)}`,
				);
			}
		}
		try {
			await this.backend.promptAgent(agentId, text);
		} catch (err) {
			await this.send(channelId, `❌ Prompt failed: ${errMsg(err)}`);
		}
	}

	private setupWsHandlers(): void {
		this.backend.on("ws:message", (msg: Record<string, unknown>) => {
			const agentId = msg.agentId as string | undefined;
			if (!agentId) return;
			const channelId = this.channelForAgent(agentId);
			if (!channelId) return;
			this.handleAgentEvent(channelId, msg);
		});
	}

	private setupHostWsHandlers(): void {
		this.hostClient.on("ws:message", (msg: Record<string, unknown>) => {
			const project = msg.project as string | undefined;
			if (!project) return;
			for (const [channelId, targeted] of this.channelProject) {
				if (targeted === project) this.handleRemoteEvent(channelId, msg);
			}
		});
	}

	private handleAgentEvent(
		channelId: string,
		event: Record<string, unknown>,
	): void {
		if (event.type === "agent_exit") {
			this.channelAgents.delete(channelId);
		}
		this.handleRemoteEvent(channelId, event);
	}

	private handleRemoteEvent(
		channelId: string,
		event: Record<string, unknown>,
	): void {
		const type = event.type as string;
		if (type === "message_complete") {
			const text = (event.data as string) || "";
			if (text.trim()) void this.send(channelId, text.trim());
		} else if (type === "tool_start") {
			const data = event.data as Record<string, unknown>;
			if (data?.toolName === "bash") {
				const cmd = (data.args as Record<string, string>)?.command ?? "...";
				const preview = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
				void this.send(channelId, `🔧 \`${preview}\``);
			}
		}
	}

	private channelForAgent(agentId: string): string | null {
		for (const [channelId, id] of this.channelAgents) {
			if (id === agentId) return channelId;
		}
		return null;
	}

	private isAllowed(channelId: string): boolean {
		if (this.opts.allowedChannelIds.length === 0) return true;
		return this.opts.allowedChannelIds.includes(channelId);
	}

	private async send(channelId: string, text: string): Promise<void> {
		const channel = await this.client.channels
			.fetch(channelId)
			.catch(() => null);
		if (!channel || !channel.isTextBased()) return;
		const sendable = channel as unknown as Sendable;
		let remaining = text;
		while (remaining.length > 0) {
			const chunk = remaining.slice(0, DISCORD_MAX_LEN);
			remaining = remaining.slice(DISCORD_MAX_LEN);
			await sendable.send(chunk).catch(() => undefined);
		}
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : "unknown error";
}
