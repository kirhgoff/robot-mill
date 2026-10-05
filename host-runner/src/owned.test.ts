import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOwnedBy } from "./session";

const root = mkdtempSync(join(tmpdir(), "owned-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function checkout(name: string, origin?: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	spawnSync("git", ["init", "-q", dir]);
	if (origin) spawnSync("git", ["-C", dir, "remote", "add", "origin", origin]);
	return dir;
}

it("accepts ssh and https origins under the owner, case-insensitively", () => {
	expect(isOwnedBy(checkout("ssh", "git@github.com:kirhgoff/note-ninja-nextjs.git"), "kirhgoff")).toBe(true);
	expect(isOwnedBy(checkout("https", "https://github.com/KirhGoff/robot-mill"), "kirhgoff")).toBe(true);
});

it("rejects other owners, missing origins and plain directories", () => {
	expect(isOwnedBy(checkout("fork", "git@github.com:rmcrackan/Libation.git"), "kirhgoff")).toBe(false);
	expect(isOwnedBy(checkout("prefix", "git@github.com:kirhgoff-evil/x.git"), "kirhgoff")).toBe(false);
	expect(isOwnedBy(checkout("no-origin"), "kirhgoff")).toBe(false);
	const plain = join(root, "plain");
	mkdirSync(plain);
	expect(isOwnedBy(plain, "kirhgoff")).toBe(false);
	expect(isOwnedBy(plain, "")).toBe(false);
});
