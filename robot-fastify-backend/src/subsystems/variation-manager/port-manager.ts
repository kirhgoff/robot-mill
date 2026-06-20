/**
 * PortManager — finds free ports within a configured range.
 *
 * Checks both the OS (net.createServer probe) and the set of ports
 * already claimed by active variations.
 */

import { createServer, type Server } from "node:net";

export class PortManager {
	private readonly min: number;
	private readonly max: number;
	/** Ports currently reserved by variations. */
	private reserved = new Set<number>();

	constructor(min: number, max: number) {
		this.min = min;
		this.max = max;
	}

	/** Mark a port as reserved (called when a variation starts). */
	reserve(port: number): void {
		this.reserved.add(port);
	}

	/** Release a port (called when a variation stops). */
	release(port: number): void {
		this.reserved.delete(port);
	}

	/** Find the next free port in the range. */
	async findFree(): Promise<number> {
		for (let port = this.min; port <= this.max; port++) {
			if (this.reserved.has(port)) continue;
			if (await this.isPortFree(port)) {
				return port;
			}
		}
		throw new Error(`No free port found in range ${this.min}–${this.max}`);
	}

	private isPortFree(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const srv: Server = createServer();
			srv.once("error", () => resolve(false));
			srv.once("listening", () => {
				srv.close(() => resolve(true));
			});
			srv.listen(port, "0.0.0.0");
		});
	}
}
