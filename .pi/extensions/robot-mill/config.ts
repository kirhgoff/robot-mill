/**
 * Robot Mill — Configuration Loading
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { RobotState } from "./types.ts";
import { DEFAULT_CONFIG } from "./state.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export async function loadConfig(state: RobotState, cwd: string): Promise<void> {
  const configPath = join(cwd, ".robot-mill.json");
  
  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(content);
      state.config = { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      console.error(`Failed to load config: ${err}`);
      state.config = { ...DEFAULT_CONFIG };
    }
  } else {
    state.config = { ...DEFAULT_CONFIG };
  }
}
