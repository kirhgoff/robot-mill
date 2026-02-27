/**
 * Robot Mill — Markdown Parsing Helpers
 * 
 * Handles frontmatter parsing, task serialization, and notes management.
 */

import type { Task, TaskNote, TaskStatus } from "../types.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// FRONTMATTER PARSING
// ═══════════════════════════════════════════════════════════════════════════════

export function parseFrontmatter(markdown: string): { 
  frontmatter: Record<string, unknown>; 
  content: string 
} {
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
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      let value: unknown = trimmed.slice(colonIndex + 1).trim();

      // Parse arrays: [item1, item2]
      if ((value as string).startsWith("[") && (value as string).endsWith("]")) {
        value = (value as string)
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } 
      // Parse null
      else if (value === "null" || value === "~") {
        value = null;
      } 
      // Parse booleans
      else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      } 
      // Parse numbers
      else if (/^-?\d+(\.\d+)?$/.test(value as string)) {
        value = parseFloat(value as string);
      }

      frontmatter[key] = value;
    }
  }

  return { frontmatter, content };
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  
  lines.push("---");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTES PARSING
// ═══════════════════════════════════════════════════════════════════════════════

export function parseNotes(content: string): { 
  description: string; 
  notes: TaskNote[] 
} {
  const notes: TaskNote[] = [];
  const notesMatch = content.match(/^## Notes\s*$/m);
  
  if (!notesMatch) {
    return { description: content.trim(), notes: [] };
  }

  const notesIndex = content.indexOf(notesMatch[0]);
  const description = content.slice(0, notesIndex).trim();
  const notesSection = content.slice(notesIndex + notesMatch[0].length).trim();

  // Parse individual notes: ### TIMESTAMP - AUTHOR - TYPE
  const noteRegex = /^### (\S+) - (\w+) - (\w+)\s*$/gm;
  const matches: { index: number; timestamp: string; author: string; type: string }[] = [];
  let match;

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
    const headerEnd = notesSection.indexOf("\n", current.index);
    const noteContent = notesSection.slice(headerEnd + 1, endIndex).trim();

    notes.push({
      timestamp: current.timestamp,
      author: current.author,
      type: current.type as TaskNote["type"],
      content: noteContent,
    });
  }

  return { description, notes };
}

export function serializeNotes(notes: TaskNote[]): string {
  if (notes.length === 0) return "";
  
  const lines = ["", "## Notes", ""];
  
  for (const note of notes) {
    lines.push(`### ${note.timestamp} - ${note.author} - ${note.type}`);
    lines.push("");
    lines.push(note.content);
    lines.push("");
  }
  
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK PARSING & SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export function parseTaskMarkdown(content: string, fallbackId: string): Task {
  const { frontmatter, content: body } = parseFrontmatter(content);
  const { description, notes } = parseNotes(body);

  return {
    id: (frontmatter.id as string) || fallbackId,
    title: (frontmatter.title as string) || "Untitled",
    description,
    status: (frontmatter.status as TaskStatus) || "todo",
    humanBuddy: (frontmatter.humanBuddy as string) || "unknown",
    repository: (frontmatter.repository as string) || "",
    branch: frontmatter.branch as string | undefined,
    assignee: frontmatter.assignee as string | undefined,
    priority: frontmatter.priority as number | undefined,
    labels: frontmatter.labels as string[] | undefined,
    notes,
    createdAt: (frontmatter.createdAt as string) || new Date().toISOString(),
    updatedAt: (frontmatter.updatedAt as string) || new Date().toISOString(),
  };
}

export function serializeTask(task: Task): string {
  const frontmatter = serializeFrontmatter({
    id: task.id,
    title: task.title,
    status: task.status,
    humanBuddy: task.humanBuddy,
    repository: task.repository,
    branch: task.branch || null,
    assignee: task.assignee || null,
    priority: task.priority || null,
    labels: task.labels || [],
    createdAt: task.createdAt,
    updatedAt: new Date().toISOString(),
  });

  const description = task.description ? `\n## Description\n\n${task.description}` : "";
  const notes = serializeNotes(task.notes);

  return `${frontmatter}\n${description}\n${notes}`;
}
