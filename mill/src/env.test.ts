import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, parseEnv, requiredKeys } from "./env";

const example = readFileSync(join(import.meta.dir, "..", "mill.env.example"), "utf8");

function envFile(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), "mill-env-")), "mill.env");
  writeFileSync(path, text);
  return path;
}

const fullEnv = Object.fromEntries(requiredKeys.map((key) => [key, "x"]));

test("parseEnv strips quotes and drops empty values and comments", () => {
  expect(parseEnv("A='one'\nB=\"two\"\nC=\nD=3\n# E=5\n")).toEqual({ A: "one", B: "two", D: "3" });
});

test("loadEnv fills missing variables but keeps ones already set", () => {
  const env: Record<string, string | undefined> = { ...fullEnv, MILL_PORT: "1" };
  loadEnv(envFile("MILL_PORT=2\nMILL_POOL=claude\n"), env);
  expect(env.MILL_PORT).toBe("1");
  expect(env.MILL_POOL).toBe("claude");
});

test("loadEnv lists every missing required key", () => {
  const path = envFile("TELEGRAM_BOT_TOKEN=t\n");
  expect(() => loadEnv(path, {})).toThrow(requiredKeys.slice(1).join(", "));
});

test("mill.env.example has the required keys uncommented", () => {
  const uncommented = example.split("\n").filter((line) => /^[A-Z_]+=$/.test(line)).map((line) => line.slice(0, -1));
  expect(uncommented).toEqual(requiredKeys);
});

test("mill.env.example lists every variable the code reads", () => {
  const sources = readdirSync(import.meta.dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const used = new Set(sources.flatMap((name) => [...readFileSync(join(import.meta.dir, name), "utf8").matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1])));
  for (const key of used) expect(example).toContain(`${key}=`);
});
