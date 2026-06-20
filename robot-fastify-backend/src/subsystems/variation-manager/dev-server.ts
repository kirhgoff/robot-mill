/**
 * DevServerManager — spawns and tracks dev server processes.
 *
 * Each variation gets its own dev server on a unique port.
 * The process runs inside the container; the worktree files are on a bind-mount.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export interface DevServerInfo {
	variationId: string;
	port: number;
	pid: number | null;
	alive: boolean;
}

interface RunningServer {
	proc: ChildProcess;
	port: number;
	variationId: string;
}

export class DevServerManager extends EventEmitter {
	private servers = new Map<string, RunningServer>();

	/**
	 * Start a dev server for a variation.
	 *
	 * Runs `bun run dev -- --port <port> --host 0.0.0.0` in the worktree.
	 */
	async start(
		variationId: string,
		worktreePath: string,
		port: number,
	): Promise<DevServerInfo> {
		if (this.servers.has(variationId)) {
			throw new Error(
				`Dev server for variation "${variationId}" is already running`,
			);
		}

		// Install dependencies first
		await this.installDeps(worktreePath);

		// Determine how to start the dev server
		const { command, args } = this.resolveStartCommand(worktreePath, port);

		const proc = spawn(command, args, {
			cwd: worktreePath,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: {
				...process.env,
				PORT: String(port),
				HOST: "0.0.0.0",
			},
		});

		const server: RunningServer = { proc, port, variationId };
		this.servers.set(variationId, server);

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			this.emit("log", { variationId, stream: "stdout", text: chunk });
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			this.emit("log", { variationId, stream: "stderr", text: chunk });
		});

		proc.on("close", (code) => {
			this.servers.delete(variationId);
			this.emit("exit", { variationId, code });
		});

		proc.on("error", (err) => {
			this.servers.delete(variationId);
			this.emit("error", { variationId, error: err.message });
		});

		return {
			variationId,
			port,
			pid: proc.pid ?? null,
			alive: true,
		};
	}

	/** Stop a running dev server. */
	stop(variationId: string): void {
		const server = this.servers.get(variationId);
		if (!server) return;

		try {
			// Kill the process group to also kill child processes
			if (server.proc.pid) {
				process.kill(-server.proc.pid, "SIGTERM");
			}
		} catch {
			try {
				server.proc.kill("SIGTERM");
			} catch {
				// Already dead
			}
		}

		this.servers.delete(variationId);
	}

	/** Stop all running dev servers. */
	stopAll(): void {
		for (const [id] of this.servers) {
			this.stop(id);
		}
	}

	/** Check if a variation has a running dev server. */
	isRunning(variationId: string): boolean {
		return this.servers.has(variationId);
	}

	/** Get the port of a running server. */
	getPort(variationId: string): number | null {
		return this.servers.get(variationId)?.port ?? null;
	}

	/** Get PID of a running server. */
	getPid(variationId: string): number | null {
		return this.servers.get(variationId)?.proc.pid ?? null;
	}

	private resolveStartCommand(
		worktreePath: string,
		port: number,
	): { command: string; args: string[] } {
		// Use bun run dev — delegates to whatever "dev" script the project defines
		return {
			command: "bun",
			args: ["run", "dev", "--", "--port", String(port), "--host", "0.0.0.0"],
		};
	}

	private installDeps(worktreePath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const pkgLock = join(worktreePath, "package-lock.json");
			const bunLock = join(worktreePath, "bun.lock");
			const pnpmLock = join(worktreePath, "pnpm-lock.yaml");

			let command: string;
			let args: string[];

			if (existsSync(bunLock)) {
				command = "bun";
				args = ["install"];
			} else if (existsSync(pnpmLock)) {
				command = "pnpm";
				args = ["install", "--frozen-lockfile"];
			} else {
				command = "npm";
				args = ["install"];
			}

			const proc = spawn(command, args, {
				cwd: worktreePath,
				stdio: ["ignore", "pipe", "pipe"],
			});

			proc.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`${command} install failed with code ${code}`));
			});

			proc.on("error", reject);
		});
	}
}
