import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  AlreadyClaimedError,
  type AppendDetailsEntry,
  type TaskDetails,
  type TaskStatus,
  type TaskSummary,
  type TaskSource,
} from '@robot/core';

type Frontmatter = {
  id: string;
  title: string;
  status: TaskStatus;
  buddy: string;
  assignedTo: string | null;
  repo: string;
  branch?: string | null;
  updatedAt?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function parseFrontmatter(src: string): { fm: Frontmatter; body: string } {
  if (!src.startsWith('---\n')) throw new Error('Missing frontmatter');
  const end = src.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('Unterminated frontmatter');
  const raw = src.slice(4, end);
  const body = src.slice(end + '\n---\n'.length);
  const fm = yaml.load(raw);
  if (!fm || typeof fm !== 'object') throw new Error('Invalid frontmatter');
  return { fm: fm as Frontmatter, body };
}

function serializeFrontmatter(fm: Frontmatter, body: string): string {
  const raw = yaml.dump(fm, { lineWidth: 1000 }).trimEnd();
  const normalizedBody = body.startsWith('\n') ? body : `\n${body}`;
  return `---\n${raw}\n---${normalizedBody}`;
}

function ensureDetailsSection(body: string) {
  if (body.includes('\n## Details (append-only)\n')) return body;
  const trimmed = body.trimEnd();
  if (trimmed.length === 0) return '\n## Description\n\n\n## Details (append-only)\n';
  return `${trimmed}\n\n## Details (append-only)\n`;
}

function extractDescription(body: string): string {
  const descHeader = '\n## Description\n';
  const detailsHeader = '\n## Details (append-only)\n';
  const start = body.indexOf(descHeader);
  if (start === -1) return body.trim();
  const from = start + descHeader.length;
  const end = body.indexOf(detailsHeader, from);
  const slice = end === -1 ? body.slice(from) : body.slice(from, end);
  return slice.trim();
}

function parseDetailsFeed(body: string): TaskDetails['detailsFeed'] {
  const header = '\n## Details (append-only)\n';
  const start = body.indexOf(header);
  if (start === -1) return [];
  const text = body.slice(start + header.length);
  const entries: TaskDetails['detailsFeed'] = [];
  const parts = text.split('\n### ').filter((p) => p.trim().length > 0);
  for (const part of parts) {
    const [firstLine, ...rest] = part.split('\n');
    if (!firstLine) continue;
    const m = firstLine.match(/^([^ ]+)\s+([^ ]+)\s+(plan|questions|implementation|note)\s*$/);
    if (!m) continue;
    const at = m[1] ?? '';
    const by = m[2] ?? '';
    const type = m[3] as TaskDetails['detailsFeed'][number]['type'];
    const body = rest.join('\n').trim();
    entries.push({ at, by, type, body });
  }
  return entries;
}

export class MarkdownTaskSource implements TaskSource {
  constructor(private readonly dir: string) {}

  private taskPath(id: string) {
    return join(this.dir, `${id}.md`);
  }

  async getTaskList(): Promise<TaskSummary[]> {
    const files = await readdir(this.dir);
    const tasks: TaskSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const src = await readFile(join(this.dir, file), 'utf8');
      const { fm } = parseFrontmatter(src);
      if (fm.status !== 'todo') continue;
      if (fm.assignedTo !== null) continue;
      tasks.push({
        id: fm.id,
        title: fm.title,
        status: fm.status,
        buddy: fm.buddy,
        repo: fm.repo,
        ...(fm.branch ? { branch: fm.branch } : {}),
      });
    }
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    return tasks;
  }

  async getTaskDetails(id: string): Promise<TaskDetails> {
    const src = await readFile(this.taskPath(id), 'utf8');
    const { fm, body } = parseFrontmatter(src);
    return {
      id: fm.id,
      title: fm.title,
      status: fm.status,
      buddy: fm.buddy,
      repo: fm.repo,
      ...(fm.branch ? { branch: fm.branch } : {}),
      assignedTo: fm.assignedTo,
      description: extractDescription(body),
      detailsFeed: parseDetailsFeed(body),
    };
  }

  async appendDetails(id: string, entry: AppendDetailsEntry): Promise<void> {
    const path = this.taskPath(id);
    const src = await readFile(path, 'utf8');
    const parsed = parseFrontmatter(src);
    const fm = parsed.fm;
    const at = entry.at ?? nowIso();
    const nextBody = ensureDetailsSection(parsed.body).trimEnd();
    const appended = `${nextBody}\n\n### ${at} ${entry.by} ${entry.type}\n${entry.body.trimEnd()}\n`;
    const nextFm: Frontmatter = { ...fm, updatedAt: nowIso() };
    await writeFile(path, serializeFrontmatter(nextFm, appended), 'utf8');
  }

  async startWorking(id: string, robotId: string): Promise<void> {
    const path = this.taskPath(id);
    const src = await readFile(path, 'utf8');
    const { fm, body } = parseFrontmatter(src);
    if (fm.status !== 'todo' || fm.assignedTo !== null) throw new AlreadyClaimedError();
    const nextFm: Frontmatter = {
      ...fm,
      status: 'in_progress',
      assignedTo: `robot:${robotId}`,
      updatedAt: nowIso(),
    };
    await writeFile(path, serializeFrontmatter(nextFm, body), 'utf8');
  }

  async stopWorkingNeedInfo(id: string): Promise<void> {
    const path = this.taskPath(id);
    const src = await readFile(path, 'utf8');
    const { fm, body } = parseFrontmatter(src);
    const nextFm: Frontmatter = {
      ...fm,
      status: 'todo',
      assignedTo: fm.buddy,
      updatedAt: nowIso(),
    };
    await writeFile(path, serializeFrontmatter(nextFm, body), 'utf8');
  }

  async stopWorkingNeedReview(id: string): Promise<void> {
    const path = this.taskPath(id);
    const src = await readFile(path, 'utf8');
    const { fm, body } = parseFrontmatter(src);
    const nextFm: Frontmatter = {
      ...fm,
      status: 'in_review',
      assignedTo: fm.buddy,
      updatedAt: nowIso(),
    };
    await writeFile(path, serializeFrontmatter(nextFm, body), 'utf8');
  }
}
