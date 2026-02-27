/**
 * Task Source Factory
 * 
 * Creates the appropriate TaskSource based on configuration.
 */

import type { TaskSource, RobotConfig } from "../types.js";
import { MarkdownTaskSource } from "./markdown-source.js";
import { JiraTaskSource } from "./jira-source.js";

export function createTaskSource(config: RobotConfig["taskSource"]): TaskSource {
  switch (config.type) {
    case "markdown":
      if (!config.tasksDir) {
        throw new Error("tasksDir is required for markdown task source");
      }
      return new MarkdownTaskSource(config.tasksDir);

    case "jira":
      return JiraTaskSource.fromEnv();

    default:
      throw new Error(`Unknown task source type: ${(config as any).type}`);
  }
}

export { MarkdownTaskSource } from "./markdown-source.js";
export { JiraTaskSource } from "./jira-source.js";
