/**
 * Markdown Task Source
 * 
 * Manages tasks as markdown files with YAML frontmatter.
 * 
 * File format:
 * ```markdown
 * ---
 * id: task-001
 * title: Implement user authentication
 * status: todo
 * humanBuddy: kirill
 * repository: https://github.com/org/repo
 * branch: feature/auth
 * priority: 1
 * labels: [backend, security]
 * assignee: null
 * ---
 * 
 * ## Description
 * 
 * Full task description here...
 * 
 * ## Notes
 * 
 * ### 2024-01-15T10:00:00Z - robot - plan
 * Implementation plan...
 * 
 * ### 2024-01-15T11:00:00Z - robot - question
 * Clarifying questions...
 * ```
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";
import type {
  TaskSource,
  TaskSummary,
  TaskDetails,
  TaskNote,
  AppendDetailsInput,
  TaskStatus,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// YAML FRONTMATTER PARSER (Simple implementation - no external deps)
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  content: string;
}

function parseFrontmatter(markdown: string): ParsedMarkdown {
  const lines = markdown.split("\n");
  
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, content: markdown };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, content: markdown };
  }

  const yamlLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join("\n").trim();

  // Simple YAML parser for our use case
  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";
  let currentValue = "";
  let inArray = false;
  let arrayValues: string[] = [];

  for (const line of yamlLines) {
    const trimmed = line.trim();
    
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Array item
    if (trimmed.startsWith("- ") && inArray) {
      arrayValues.push(trimmed.slice(2).trim());
      continue;
    }

    // Save previous array if we were in one
    if (inArray && currentKey) {
      frontmatter[currentKey] = arrayValues;
      inArray = false;
      arrayValues = [];
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      currentKey = trimmed.slice(0, colonIndex).trim();
      currentValue = trimmed.slice(colonIndex + 1).trim();

      // Inline array: [a, b, c]
      if (currentValue.startsWith("[") && currentValue.endsWith("]")) {
        const inner = currentValue.slice(1, -1);
        frontmatter[currentKey] = inner
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      // Start of multi-line array
      else if (currentValue === "") {
        inArray = true;
        arrayValues = [];
      }
      // null value
      else if (currentValue === "null" || currentValue === "~") {
        frontmatter[currentKey] = null;
      }
      // boolean
      else if (currentValue === "true") {
        frontmatter[currentKey] = true;
      } else if (currentValue === "false") {
        frontmatter[currentKey] = false;
      }
      // number
      else if (/^-?\d+(\.\d+)?$/.test(currentValue)) {
        frontmatter[currentKey] = parseFloat(currentValue);
      }
      // string (remove quotes if present)
      else {
        if (
          (currentValue.startsWith('"') && currentValue.endsWith('"')) ||
          (currentValue.startsWith("'") && currentValue.endsWith("'"))
        ) {
          currentValue = currentValue.slice(1, -1);
        }
        frontmatter[currentKey] = currentValue;
      }
    }
  }

  // Handle trailing array
  if (inArray && currentKey) {
    frontmatter[currentKey] = arrayValues;
  }

  return { frontmatter, content };
}

function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}: [${value.join(", ")}]`);
      }
    } else if (typeof value === "string") {
      // Quote if contains special chars
      if (value.includes(":") || value.includes("#") || value.includes("\n")) {
        lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTES PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parseNotes(content: string): { description: string; notes: TaskNote[] } {
  const notes: TaskNote[] = [];
  
  // Find ## Notes section
  const notesMatch = content.match(/^## Notes\s*$/m);
  if (!notesMatch) {
    return { description: content.trim(), notes: [] };
  }

  const notesIndex = content.indexOf(notesMatch[0]);
  const description = content.slice(0, notesIndex).trim();
  const notesSection = content.slice(notesIndex + notesMatch[0].length).trim();

  // Parse individual notes (### timestamp - author - type)
  const noteRegex = /^### (\d{4}-\d{2}-\d{2}T[\d:]+Z?) - (\w+) - (\w+)\s*$/gm;
  let match;
  let lastIndex = 0;
  const matches: { index: number; timestamp: string; author: string; type: string }[] = [];

  while ((match = noteRegex.exec(notesSection)) !== null) {
    matches.push({
      index: match.index,
      timestamp: match[1],
      author: match[2],
      type: match[3],
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const endIndex = next ? next.index : notesSection.length;
    
    // Content starts after the header line
    const headerEnd = notesSection.indexOf("\n", current.index);
    const noteContent = notesSection.slice(headerEnd + 1, endIndex).trim();

    notes.push({
      timestamp: new Date(current.timestamp),
      author: current.author,
      type: current.type as TaskNote["type"],
      content: noteContent,
    });
  }

  return { description, notes };
}

function serializeNotes(notes: TaskNote[]): string {
  if (notes.length === 0) return "";

  const lines = ["", "## Notes", ""];

  for (const note of notes) {
    const ts = note.timestamp.toISOString();
    lines.push(`### ${ts} - ${note.author} - ${note.type}`);
    lines.push("");
    lines.push(note.content);
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN TASK SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

export class MarkdownTaskSource implements TaskSource {
  readonly type = "markdown";
  readonly name = "Markdown Files";

  private tasksDir: string;

  constructor(tasksDir: string) {
    this.tasksDir = tasksDir;
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.tasksDir)) {
      await mkdir(this.tasksDir, { recursive: true });
    }
  }

  private getFilePath(id: string): string {
    // Sanitize ID for filename
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-");
    return join(this.tasksDir, `${safeId}.md`);
  }

  private async readTask(filePath: string): Promise<TaskDetails | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      const { frontmatter, content: body } = parseFrontmatter(content);
      const { description, notes } = parseNotes(body);

      return {
        id: frontmatter.id as string,
        title: frontmatter.title as string,
        status: frontmatter.status as TaskStatus,
        humanBuddy: frontmatter.humanBuddy as string,
        repository: frontmatter.repository as string,
        branch: frontmatter.branch as string | undefined,
        priority: frontmatter.priority as number | undefined,
        labels: frontmatter.labels as string[] | undefined,
        assignee: frontmatter.assignee as string | undefined,
        description,
        notes,
        createdAt: new Date(frontmatter.createdAt as string || Date.now()),
        updatedAt: new Date(frontmatter.updatedAt as string || Date.now()),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  private async writeTask(task: TaskDetails): Promise<void> {
    await this.ensureDir();

    const frontmatter = serializeFrontmatter({
      id: task.id,
      title: task.title,
      status: task.status,
      humanBuddy: task.humanBuddy,
      repository: task.repository,
      branch: task.branch || null,
      priority: task.priority || null,
      labels: task.labels || [],
      assignee: task.assignee || null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });

    const description = task.description
      ? `\n## Description\n\n${task.description}`
      : "";

    const notes = serializeNotes(task.notes);
    const content = `${frontmatter}\n${description}\n${notes}`;

    await writeFile(this.getFilePath(task.id), content, "utf-8");
  }

  async getTaskList(): Promise<TaskSummary[]> {
    await this.ensureDir();

    const files = await readdir(this.tasksDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    const tasks: TaskSummary[] = [];

    for (const file of mdFiles) {
      const task = await this.readTask(join(this.tasksDir, file));
      if (!task) continue;

      // Only return unassigned "todo" tasks
      if (task.status === "todo" && !task.assignee) {
        tasks.push({
          id: task.id,
          title: task.title,
          status: task.status,
          humanBuddy: task.humanBuddy,
          repository: task.repository,
          branch: task.branch,
          priority: task.priority,
          labels: task.labels,
        });
      }
    }

    // Sort by priority (lower = higher priority)
    tasks.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    return tasks;
  }

  async getTaskDetails(id: string): Promise<TaskDetails | null> {
    return this.readTask(this.getFilePath(id));
  }

  async appendDetails(id: string, input: AppendDetailsInput): Promise<void> {
    const task = await this.getTaskDetails(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.notes.push({
      timestamp: new Date(),
      author: input.author || "robot",
      type: input.type,
      content: input.content,
    });
    task.updatedAt = new Date();

    // Also update the plan/questions fields for easy access
    if (input.type === "plan") {
      task.plan = input.content;
    } else if (input.type === "question") {
      task.questions = task.questions || [];
      task.questions.push(input.content);
    }

    await this.writeTask(task);
  }

  async startWorking(id: string): Promise<void> {
    const task = await this.getTaskDetails(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.status = "in_progress";
    task.assignee = "robot";
    task.updatedAt = new Date();

    await this.writeTask(task);
  }

  async stopWorkingNeedInfo(id: string): Promise<void> {
    const task = await this.getTaskDetails(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.status = "needs_info";
    task.assignee = task.humanBuddy;
    task.updatedAt = new Date();

    await this.writeTask(task);
  }

  async stopWorkingNeedReview(id: string): Promise<void> {
    const task = await this.getTaskDetails(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.status = "in_review";
    task.assignee = task.humanBuddy;
    task.updatedAt = new Date();

    await this.writeTask(task);
  }

  async markComplete(id: string): Promise<void> {
    const task = await this.getTaskDetails(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.status = "done";
    task.assignee = undefined;
    task.updatedAt = new Date();

    await this.writeTask(task);
  }

  async createTask(
    input: Omit<TaskDetails, "id" | "notes" | "createdAt" | "updatedAt">
  ): Promise<string> {
    const id = `task-${Date.now()}`;
    const task: TaskDetails = {
      ...input,
      id,
      notes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.writeTask(task);
    return id;
  }
}
