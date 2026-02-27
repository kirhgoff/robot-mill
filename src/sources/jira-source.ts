/**
 * Jira Task Source
 * 
 * Manages tasks via Atlassian Jira REST API.
 * 
 * Configuration:
 * - JIRA_HOST: Your Jira instance (e.g., "mycompany.atlassian.net")
 * - JIRA_EMAIL: API user email
 * - JIRA_API_TOKEN: API token (create at https://id.atlassian.com/manage-profile/security/api-tokens)
 * - JIRA_PROJECT: Project key (e.g., "PROJ")
 * 
 * Custom Fields (configure these in Jira):
 * - "Robot Task" (checkbox): Marks issues as robot-workable
 * - "Human Buddy" (user picker): The human responsible
 * - "Repository" (text): GitHub repository URL
 * - "Branch" (text): Git branch name
 * 
 * Status Mapping:
 * - "To Do" / "Open" / "Backlog" → todo
 * - "In Progress" → in_progress
 * - "Needs Info" / "Blocked" → needs_info
 * - "In Review" / "Review" → in_review
 * - "Done" / "Closed" → done
 */

import type {
  TaskSource,
  TaskSummary,
  TaskDetails,
  TaskNote,
  AppendDetailsInput,
  TaskStatus,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// JIRA API TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface JiraConfig {
  host: string;
  email: string;
  apiToken: string;
  project: string;
  /** Custom field IDs - you need to find these in your Jira instance */
  customFields: {
    humanBuddy?: string;      // e.g., "customfield_10001"
    repository?: string;      // e.g., "customfield_10002"
    branch?: string;          // e.g., "customfield_10003"
    robotTask?: string;       // e.g., "customfield_10004"
  };
  /** Status name mappings */
  statusMapping: {
    todo: string[];           // Status names that map to "todo"
    inProgress: string[];
    needsInfo: string[];
    inReview: string[];
    done: string[];
  };
  /** Transition IDs for status changes */
  transitions: {
    startProgress?: string;
    needsInfo?: string;
    inReview?: string;
    done?: string;
  };
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    priority?: { name: string };
    labels?: string[];
    assignee?: { displayName: string; emailAddress: string } | null;
    comment?: {
      comments: Array<{
        id: string;
        author: { displayName: string };
        body: string;
        created: string;
      }>;
    };
    created: string;
    updated: string;
    [key: string]: unknown; // Custom fields
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JIRA TASK SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

export class JiraTaskSource implements TaskSource {
  readonly type = "jira";
  readonly name = "Jira";

  private config: JiraConfig;
  private baseUrl: string;
  private authHeader: string;

  constructor(config: JiraConfig) {
    this.config = config;
    this.baseUrl = `https://${config.host}/rest/api/3`;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  /**
   * Create from environment variables with sensible defaults
   */
  static fromEnv(): JiraTaskSource {
    const host = process.env.JIRA_HOST;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;
    const project = process.env.JIRA_PROJECT;

    if (!host || !email || !apiToken || !project) {
      throw new Error(
        "Missing required Jira environment variables: JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT"
      );
    }

    return new JiraTaskSource({
      host,
      email,
      apiToken,
      project,
      customFields: {
        humanBuddy: process.env.JIRA_FIELD_HUMAN_BUDDY,
        repository: process.env.JIRA_FIELD_REPOSITORY,
        branch: process.env.JIRA_FIELD_BRANCH,
        robotTask: process.env.JIRA_FIELD_ROBOT_TASK,
      },
      statusMapping: {
        todo: ["To Do", "Open", "Backlog", "New"],
        inProgress: ["In Progress", "In Development"],
        needsInfo: ["Needs Info", "Blocked", "Waiting"],
        inReview: ["In Review", "Review", "Code Review"],
        done: ["Done", "Closed", "Resolved"],
      },
      transitions: {
        startProgress: process.env.JIRA_TRANSITION_START,
        needsInfo: process.env.JIRA_TRANSITION_NEEDS_INFO,
        inReview: process.env.JIRA_TRANSITION_REVIEW,
        done: process.env.JIRA_TRANSITION_DONE,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error: ${response.status} ${response.statusText}\n${text}`);
    }

    // Some endpoints return no content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private mapJiraStatus(jiraStatus: string): TaskStatus {
    const { statusMapping } = this.config;
    
    if (statusMapping.todo.includes(jiraStatus)) return "todo";
    if (statusMapping.inProgress.includes(jiraStatus)) return "in_progress";
    if (statusMapping.needsInfo.includes(jiraStatus)) return "needs_info";
    if (statusMapping.inReview.includes(jiraStatus)) return "in_review";
    if (statusMapping.done.includes(jiraStatus)) return "done";
    
    // Default to todo for unknown statuses
    return "todo";
  }

  private getCustomField(issue: JiraIssue, fieldId?: string): unknown {
    if (!fieldId) return undefined;
    return issue.fields[fieldId];
  }

  private issueToTask(issue: JiraIssue): TaskDetails {
    const { customFields } = this.config;

    // Get human buddy from custom field or fall back to reporter
    let humanBuddy = "unknown";
    const buddyField = this.getCustomField(issue, customFields.humanBuddy);
    if (buddyField && typeof buddyField === "object" && "displayName" in (buddyField as object)) {
      humanBuddy = (buddyField as { displayName: string }).displayName;
    }

    // Get repository
    const repository = (this.getCustomField(issue, customFields.repository) as string) || "";

    // Get branch
    const branch = this.getCustomField(issue, customFields.branch) as string | undefined;

    // Parse comments as notes
    const notes: TaskNote[] = (issue.fields.comment?.comments || []).map((comment) => ({
      timestamp: new Date(comment.created),
      author: comment.author.displayName,
      type: this.detectNoteType(comment.body),
      content: this.parseJiraMarkup(comment.body),
    }));

    // Extract plan and questions from notes
    const planNote = notes.find((n) => n.type === "plan");
    const questionNotes = notes.filter((n) => n.type === "question");

    return {
      id: issue.key,
      title: issue.fields.summary,
      status: this.mapJiraStatus(issue.fields.status.name),
      humanBuddy,
      repository,
      branch,
      priority: this.mapJiraPriority(issue.fields.priority?.name),
      labels: issue.fields.labels,
      assignee: issue.fields.assignee?.displayName,
      description: this.parseJiraMarkup(issue.fields.description || ""),
      plan: planNote?.content,
      questions: questionNotes.map((n) => n.content),
      notes,
      createdAt: new Date(issue.fields.created),
      updatedAt: new Date(issue.fields.updated),
    };
  }

  private detectNoteType(body: string): TaskNote["type"] {
    const lower = body.toLowerCase();
    if (lower.startsWith("[plan]") || lower.includes("## plan")) return "plan";
    if (lower.startsWith("[question]") || lower.includes("?")) return "question";
    if (lower.startsWith("[answer]")) return "answer";
    if (lower.startsWith("[progress]")) return "progress";
    if (lower.startsWith("[review]")) return "review";
    return "general";
  }

  private parseJiraMarkup(text: string): string {
    if (!text) return "";
    
    // Handle Jira's Atlassian Document Format (ADF) if it's an object
    if (typeof text === "object") {
      return this.parseADF(text);
    }

    // Simple wiki markup → markdown conversion
    return text
      .replace(/\{code(:[\w]+)?\}([\s\S]*?)\{code\}/g, "```$1\n$2\n```")
      .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, "```\n$1\n```")
      .replace(/\*(\S[^*]*\S)\*/g, "**$1**")
      .replace(/_(\S[^_]*\S)_/g, "_$1_")
      .replace(/\[([^\]]+)\|([^\]]+)\]/g, "[$1]($2)")
      .replace(/h(\d)\. /g, (_, level) => "#".repeat(parseInt(level)) + " ");
  }

  private parseADF(doc: unknown): string {
    // Simplified ADF parser - extract text content
    if (!doc || typeof doc !== "object") return "";
    
    const adf = doc as { content?: unknown[] };
    if (!adf.content) return "";

    const extractText = (node: unknown): string => {
      if (!node || typeof node !== "object") return "";
      const n = node as { type?: string; text?: string; content?: unknown[] };
      
      if (n.type === "text") return n.text || "";
      if (n.content) return n.content.map(extractText).join("");
      return "";
    };

    return adf.content.map(extractText).join("\n");
  }

  private mapJiraPriority(priority?: string): number {
    switch (priority?.toLowerCase()) {
      case "highest":
      case "blocker":
        return 1;
      case "high":
      case "critical":
        return 2;
      case "medium":
        return 3;
      case "low":
        return 4;
      case "lowest":
        return 5;
      default:
        return 3;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TaskSource Implementation
  // ─────────────────────────────────────────────────────────────────────────────

  async getTaskList(): Promise<TaskSummary[]> {
    const { project, customFields, statusMapping } = this.config;

    // Build JQL query for available tasks
    const todoStatuses = statusMapping.todo.map((s) => `"${s}"`).join(", ");
    
    let jql = `project = ${project} AND status IN (${todoStatuses}) AND assignee IS EMPTY`;
    
    // If we have a robot task field, filter by it
    if (customFields.robotTask) {
      jql += ` AND "${customFields.robotTask}" = true`;
    }

    jql += " ORDER BY priority ASC, created ASC";

    const response = await this.request<JiraSearchResponse>("GET", `/search?jql=${encodeURIComponent(jql)}&maxResults=50`);

    return response.issues.map((issue) => {
      const task = this.issueToTask(issue);
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        humanBuddy: task.humanBuddy,
        repository: task.repository,
        branch: task.branch,
        priority: task.priority,
        labels: task.labels,
      };
    });
  }

  async getTaskDetails(id: string): Promise<TaskDetails | null> {
    try {
      const issue = await this.request<JiraIssue>("GET", `/issue/${id}?expand=renderedFields`);
      return this.issueToTask(issue);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        return null;
      }
      throw err;
    }
  }

  async appendDetails(id: string, input: AppendDetailsInput): Promise<void> {
    // Add a comment to the Jira issue
    const prefix = `[${input.type.toUpperCase()}]`;
    const body = `${prefix}\n\n${input.content}`;

    await this.request("POST", `/issue/${id}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    });
  }

  async startWorking(id: string): Promise<void> {
    // Transition to "In Progress"
    if (this.config.transitions.startProgress) {
      await this.request("POST", `/issue/${id}/transitions`, {
        transition: { id: this.config.transitions.startProgress },
      });
    }

    // Assign to robot (using a robot user account)
    // Note: You'd need to configure a robot user in Jira
    await this.request("PUT", `/issue/${id}/assignee`, {
      accountId: process.env.JIRA_ROBOT_ACCOUNT_ID || null,
    });
  }

  async stopWorkingNeedInfo(id: string): Promise<void> {
    // Transition to "Needs Info"
    if (this.config.transitions.needsInfo) {
      await this.request("POST", `/issue/${id}/transitions`, {
        transition: { id: this.config.transitions.needsInfo },
      });
    }

    // Get the task to find the human buddy
    const task = await this.getTaskDetails(id);
    if (task) {
      // Assign back to human buddy
      // Note: This requires knowing the account ID of the human buddy
      // You might need to look this up via the user search API
    }
  }

  async stopWorkingNeedReview(id: string): Promise<void> {
    // Transition to "In Review"
    if (this.config.transitions.inReview) {
      await this.request("POST", `/issue/${id}/transitions`, {
        transition: { id: this.config.transitions.inReview },
      });
    }
  }

  async markComplete(id: string): Promise<void> {
    // Transition to "Done"
    if (this.config.transitions.done) {
      await this.request("POST", `/issue/${id}/transitions`, {
        transition: { id: this.config.transitions.done },
      });
    }
  }

  async createTask(
    input: Omit<TaskDetails, "id" | "notes" | "createdAt" | "updatedAt">
  ): Promise<string> {
    const { customFields, project } = this.config;

    const fields: Record<string, unknown> = {
      project: { key: project },
      issuetype: { name: "Task" },
      summary: input.title,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: input.description }],
          },
        ],
      },
      labels: input.labels,
    };

    // Add custom fields
    if (customFields.repository && input.repository) {
      fields[customFields.repository] = input.repository;
    }
    if (customFields.branch && input.branch) {
      fields[customFields.branch] = input.branch;
    }
    if (customFields.robotTask) {
      fields[customFields.robotTask] = true;
    }

    const response = await this.request<{ key: string }>("POST", "/issue", {
      fields,
    });

    return response.key;
  }
}
