import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { reindex, frontmatterToRow, VaultSource } from '../db/sync';
import {
  listTasks, getNote, upsertNote, deleteNote as dbDeleteNote,
  searchNotes, taskStats, NoteRow, TaskFilter,
} from '../db/queries';
import { VaultStore, parseFrontmatter } from '../vault/store';
import { NoteFrontmatter, TaskStatus, VaultScope } from '../vault/types';
import { resolveRef, PREFIX_FOR_STATUS } from './shorthand';

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const globalPath = getArg('global-path', path.join(os.homedir(), '.groundwork'));
const workspacePath = getArg('workspace-path', '');

// --- Init DB ---
const dbPath = path.join(globalPath, '.index.db');
const db = new GroundworkDB(dbPath);

// --- Init VaultStores ---
const globalStore = new VaultStore(globalPath, 'global');
let workspaceStore: VaultStore | undefined;
if (workspacePath && fs.existsSync(workspacePath)) {
  workspaceStore = new VaultStore(workspacePath, 'workspace');
}

function storeForPath(filePath: string): VaultStore {
  if (workspaceStore && filePath.startsWith(workspacePath)) return workspaceStore;
  return globalStore;
}

function scopeForPath(filePath: string): VaultScope {
  return (workspaceStore && filePath.startsWith(workspacePath)) ? 'workspace' : 'global';
}

function defaultScope(): VaultScope {
  return workspaceStore ? 'workspace' : 'global';
}

function rootForScope(scope: VaultScope): string {
  return scope === 'workspace' && workspacePath ? workspacePath : globalPath;
}

/** Write a note file + update DB (write-through). */
async function writeAndSync(filePath: string, fm: NoteFrontmatter, body: string): Promise<void> {
  const store = storeForPath(filePath);
  await store.writeNote(filePath, fm, body);
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const row = frontmatterToRow(fm, filePath, scopeForPath(filePath), bodyHash);
  upsertNote(db, row, body);
  db.saveToDisk();
}

/** Build shorthand for a task given its status and path. */
function shorthandFor(taskPath: string, status: string): string | null {
  const prefix = PREFIX_FOR_STATUS[status];
  if (!prefix) return null;
  const rows = db.all<{ path: string }>(
    `SELECT path FROM notes
     WHERE type = 'task' AND status = ?
     ORDER BY
       CASE WHEN sort_order IS NOT NULL THEN 0 ELSE 1 END,
       sort_order,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
       title COLLATE NOCASE`,
    [status]
  );
  const idx = rows.findIndex(r => r.path === taskPath);
  return idx >= 0 ? `${prefix}${idx + 1}` : null;
}

// --- Error helpers ---
function notFound(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'NOT_FOUND' }) }], isError: true as const };
}
function invalidRef(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'INVALID_REF' }) }], isError: true as const };
}
function validationError(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'VALIDATION_ERROR' }) }], isError: true as const };
}
function writeFailed(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'WRITE_FAILED' }) }], isError: true as const };
}
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// --- MCP Server ---
async function main() {
  await db.open();
  initSchema(db);

  // Reindex on startup
  const sources: VaultSource[] = [{ rootDir: globalPath, scope: 'global' }];
  if (workspaceStore) sources.push({ rootDir: workspacePath, scope: 'workspace' });
  await reindex(db, sources);
  db.saveToDisk();

  const server = new McpServer(
    { name: 'groundwork', version: '0.5.0' },
    { instructions: 'Groundwork vault management. Use list_tasks to see tasks, get_note to read details, update_note to change fields. Prefer path over shorthand for updates.' }
  );

  // ── list_tasks ──
  server.registerTool(
    'list_tasks',
    {
      description: 'List tasks from the Groundwork vault, filtered and sorted.',
      inputSchema: {
        status: z.enum(['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled']).optional().describe('Filter by GTD status'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Filter by priority'),
        project: z.string().optional().describe('Filter by project name'),
        tag: z.string().optional().describe('Filter by tag'),
        context: z.string().optional().describe('Filter by @-context'),
        scope: z.enum(['global', 'workspace']).optional().describe('Filter by vault scope'),
        limit: z.number().optional().describe('Max results (default 50)'),
      },
    },
    async (params) => {
      const filter: TaskFilter = {
        status: params.status,
        priority: params.priority,
        project: params.project,
        tag: params.tag,
        context: params.context,
        scope: params.scope,
        limit: params.limit ?? 50,
      };
      const rows = listTasks(db, filter);
      const results = rows.map(r => ({
        path: r.path,
        shorthand: r.status ? shorthandFor(r.path, r.status) : null,
        title: r.title,
        status: r.status,
        priority: r.priority,
        due: r.due,
        sort_order: r.sort_order,
        project: r.project,
        tags: r.tags ? JSON.parse(r.tags) : [],
        scope: r.scope,
      }));
      return ok(results);
    }
  );

  // ── get_note ──
  server.registerTool(
    'get_note',
    {
      description: 'Get full content of a note or task by path or shorthand (e.g. N1, A2).',
      inputSchema: {
        ref: z.string().describe('Absolute path, relative path, or shorthand (N1, A2, etc.)'),
      },
    },
    async ({ ref }) => {
      const filePath = resolveRef(db, ref, globalPath, workspacePath || undefined);
      if (!filePath) return invalidRef(`Cannot resolve ref: ${ref}`);

      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        return ok({ path: filePath, frontmatter, body });
      } catch {
        return notFound(`File not found: ${filePath}`);
      }
    }
  );

  // ── create_task ──
  server.registerTool(
    'create_task',
    {
      description: `Create a new task in the vault.

Before calling this tool, ask the user: "Would you like to add any details or context to this task? (press Enter to skip)"
- If the user provides context, generate a well-structured markdown body from it and include it in the \`body\` parameter.
- If the user says no, none, or just presses Enter, call this tool without a \`body\`.

Exception: if the user said "just capture it", "quick note", or similar, skip the question and create immediately with no body.`,
      inputSchema: {
        title: z.string().describe('Task title'),
        status: z.enum(['inbox', 'next', 'active', 'waiting', 'someday']).optional().describe('GTD status (default: inbox)'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority (default: medium)'),
        due: z.string().optional().describe('Due date (ISO format, e.g. 2026-04-15)'),
        project: z.string().optional().describe('Project name'),
        tags: z.array(z.string()).optional().describe('Tags'),
        context: z.array(z.string()).optional().describe('GTD contexts (e.g. @computer)'),
        body: z.string().optional().describe('Task body (markdown). Generate from context the user provides. Omit if the user declines to add context.'),
        scope: z.enum(['global', 'workspace']).optional().describe('Vault scope (default: workspace if available)'),
      },
    },
    async (params) => {
      const scope = params.scope ?? defaultScope();
      const root = rootForScope(scope);
      const store = scope === 'workspace' && workspaceStore ? workspaceStore : globalStore;

      const status = (params.status as TaskStatus) ?? 'inbox';
      const slug = params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const dir = path.join(root, status === 'inbox' ? 'inbox' : status);
      const filePath = await store.findAvailablePath(dir, slug);

      const fm: NoteFrontmatter = {
        title: params.title,
        type: 'task',
        status,
        priority: params.priority ?? 'medium',
        created: new Date().toISOString(),
      };
      if (params.due) fm.due = params.due;
      if (params.project) fm.project = params.project;
      if (params.tags?.length) fm.tags = params.tags;
      if (params.context?.length) fm.context = params.context;

      try {
        const body = params.body?.trim() ?? '';
        await writeAndSync(filePath, fm, body);
        const shorthand = shorthandFor(filePath, fm.status ?? 'inbox');
        const result: Record<string, unknown> = { path: filePath, shorthand };
        if (!body) { result.bodyWasEmpty = true; result.hint = 'Body is empty — call update_note with a body if the user wants to add context.'; }
        return ok(result);
      } catch (err) {
        return writeFailed(`Failed to create task: ${err}`);
      }
    }
  );

  // ── create_note ──
  server.registerTool(
    'create_note',
    {
      description: `Create a new note, decision, project, or reference document in the vault.

Before calling this tool, ask the user: "Would you like to add any details or context to this note? (press Enter to skip)"
- If the user provides context, generate a well-structured markdown body from it and include it in the \`body\` parameter.
- If the user says no, none, or just presses Enter, call this tool without a \`body\`.

Exception: if the user said "just capture it", "quick note", or similar, skip the question and create immediately with no body.`,
      inputSchema: {
        title: z.string().describe('Note title'),
        type: z.enum(['note', 'decision', 'project', 'reference', 'log']).describe('Note type'),
        body: z.string().optional().describe('Note body (markdown). Generate from context the user provides. Omit if the user declines to add context.'),
        project: z.string().optional().describe('Project name'),
        tags: z.array(z.string()).optional().describe('Tags'),
        scope: z.enum(['global', 'workspace']).optional().describe('Vault scope'),
      },
    },
    async (params) => {
      const scope = params.scope ?? 'global';
      const root = rootForScope(scope);
      const store = scope === 'workspace' && workspaceStore ? workspaceStore : globalStore;

      const typeDir: Record<string, string> = {
        note: 'notes', decision: 'decisions', project: 'projects',
        reference: 'reference', log: 'logs',
      };
      const dir = path.join(root, typeDir[params.type] ?? 'notes');
      const slug = params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = await store.findAvailablePath(dir, slug);

      const fm: NoteFrontmatter = {
        title: params.title,
        type: params.type as NoteFrontmatter['type'],
        created: new Date().toISOString(),
      };
      if (params.project) fm.project = params.project;
      if (params.tags?.length) fm.tags = params.tags;

      try {
        const body = params.body?.trim() ?? '';
        await writeAndSync(filePath, fm, body);
        const result: Record<string, unknown> = { path: filePath };
        if (!body) { result.bodyWasEmpty = true; result.hint = 'Body is empty — call update_note with a body if the user wants to add context.'; }
        return ok(result);
      } catch (err) {
        return writeFailed(`Failed to create note: ${err}`);
      }
    }
  );

  // ── update_note ──
  server.registerTool(
    'update_note',
    {
      description: 'Update fields on an existing note or task. If status changes on a task, the file is moved to the appropriate directory.',
      inputSchema: {
        ref: z.string().describe('Path or shorthand'),
        fields: z.object({
          title: z.string().optional(),
          status: z.enum(['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled']).optional(),
          priority: z.enum(['high', 'medium', 'low']).optional(),
          due: z.string().optional(),
          project: z.string().optional(),
          tags: z.array(z.string()).optional(),
          context: z.array(z.string()).optional(),
          body: z.string().optional(),
          sort_order: z.number().optional(),
        }).describe('Fields to update'),
      },
    },
    async ({ ref, fields }) => {
      const filePath = resolveRef(db, ref, globalPath, workspacePath || undefined);
      if (!filePath) return invalidRef(`Cannot resolve ref: ${ref}`);

      let raw: string;
      try {
        raw = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        return notFound(`File not found: ${filePath}`);
      }

      const { frontmatter, body: existingBody } = parseFrontmatter(raw);
      const updatedFields: string[] = [];

      if (fields.title !== undefined) { frontmatter.title = fields.title; updatedFields.push('title'); }
      if (fields.priority !== undefined) { frontmatter.priority = fields.priority; updatedFields.push('priority'); }
      if (fields.due !== undefined) { frontmatter.due = fields.due; updatedFields.push('due'); }
      if (fields.project !== undefined) { frontmatter.project = fields.project; updatedFields.push('project'); }
      if (fields.tags !== undefined) { frontmatter.tags = fields.tags; updatedFields.push('tags'); }
      if (fields.context !== undefined) { frontmatter.context = fields.context; updatedFields.push('context'); }
      if (fields.sort_order !== undefined) { (frontmatter as Record<string, unknown>)['sort-order'] = fields.sort_order; updatedFields.push('sort_order'); }

      const newBody = fields.body !== undefined ? fields.body : existingBody;
      if (fields.body !== undefined) updatedFields.push('body');

      // Handle status change
      if (fields.status !== undefined && fields.status !== frontmatter.status) {
        frontmatter.status = fields.status as TaskStatus;
        updatedFields.push('status');
      }

      try {
        await writeAndSync(filePath, frontmatter, newBody);
        return ok({ path: filePath, updated_fields: updatedFields });
      } catch (err) {
        return writeFailed(`Failed to update: ${err}`);
      }
    }
  );

  // ── move_note ──
  server.registerTool(
    'move_note',
    {
      description: 'Move a note between scopes (global/workspace) or change its type (moves to appropriate directory).',
      inputSchema: {
        ref: z.string().describe('Path or shorthand'),
        target_scope: z.enum(['global', 'workspace']).optional().describe('Target vault scope'),
        target_type: z.enum(['note', 'decision', 'project', 'reference', 'log']).optional().describe('Target type (changes directory)'),
      },
    },
    async ({ ref, target_scope, target_type }) => {
      const filePath = resolveRef(db, ref, globalPath, workspacePath || undefined);
      if (!filePath) return invalidRef(`Cannot resolve ref: ${ref}`);

      let raw: string;
      try {
        raw = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        return notFound(`File not found: ${filePath}`);
      }

      const { frontmatter, body } = parseFrontmatter(raw);
      const scope = target_scope ?? scopeForPath(filePath);
      const root = rootForScope(scope);
      const store = scope === 'workspace' && workspaceStore ? workspaceStore : globalStore;

      if (target_type) frontmatter.type = target_type as NoteFrontmatter['type'];

      const typeDir: Record<string, string> = {
        task: 'inbox', note: 'notes', decision: 'decisions',
        project: 'projects', reference: 'reference', log: 'logs',
      };
      const dir = path.join(root, typeDir[frontmatter.type ?? 'note'] ?? 'notes');
      const slug = path.basename(filePath, '.md');
      const newPath = await store.findAvailablePath(dir, slug);

      try {
        await writeAndSync(newPath, frontmatter, body);
        // Delete old file and DB entry
        await fs.promises.unlink(filePath);
        dbDeleteNote(db, filePath);
        db.saveToDisk();
        return ok({ old_path: filePath, new_path: newPath });
      } catch (err) {
        return writeFailed(`Failed to move: ${err}`);
      }
    }
  );

  // ── search ──
  server.registerTool(
    'search',
    {
      description: 'Full-text search across vault note titles and body content. ' +
        'Supports prefix matching (e.g. "optim*"), exact phrases (e.g. \'"cloud spend"\'), ' +
        'and OR queries (e.g. "cost OR budget OR spend"). ' +
        'Multi-word queries require all words to match; falls back to OR automatically if few results found. ' +
        'For best results, include synonyms and alternate phrasings.',
      inputSchema: {
        query: z.string().describe('Search query — supports FTS5 syntax: prefix* matching, "exact phrases", and OR operator'),
        type: z.string().optional().describe('Filter by note type'),
        status: z.string().optional().describe('Filter by status'),
        scope: z.enum(['global', 'workspace']).optional().describe('Filter by scope'),
        limit: z.number().optional().describe('Max results (default 20)'),
      },
    },
    async (params) => {
      const results = searchNotes(
        db,
        params.query,
        { type: params.type, status: params.status, scope: params.scope },
        params.limit ?? 20
      );
      return ok(results.map(r => ({
        path: r.path,
        title: r.title,
        type: r.type,
        status: r.status,
        scope: r.scope,
      })));
    }
  );

  // ── daily_briefing ──
  server.registerTool(
    'daily_briefing',
    {
      description: 'Get a structured daily briefing of current work.',
      inputSchema: {},
    },
    async () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const soonDate = new Date();
      soonDate.setDate(soonDate.getDate() + 3);
      const soonStr = soonDate.toISOString().slice(0, 10);
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const weekAgoStr = weekAgo.toISOString().slice(0, 10);

      const allOpen = listTasks(db, {});
      const overdue = allOpen.filter(r => r.due && r.due < todayStr && r.status !== 'done' && r.status !== 'cancelled');
      const dueSoon = allOpen.filter(r => r.due && r.due >= todayStr && r.due <= soonStr && r.status !== 'done' && r.status !== 'cancelled');
      const active = listTasks(db, { status: 'active' });
      const next = listTasks(db, { status: 'next' });
      const waiting = listTasks(db, { status: 'waiting' });
      const stats = taskStats(db);

      // Recently completed — tasks done in last 7 days
      const recentlyCompleted = db.all<NoteRow>(
        "SELECT * FROM notes WHERE type = 'task' AND status = 'done' AND modified >= ? ORDER BY modified DESC LIMIT 20",
        [weekAgoStr]
      );

      const brief = (r: NoteRow) => ({
        path: r.path, title: r.title, status: r.status, priority: r.priority,
        due: r.due, project: r.project, scope: r.scope,
        shorthand: r.status ? shorthandFor(r.path, r.status) : null,
      });

      return ok({
        overdue: overdue.map(brief),
        due_soon: dueSoon.map(brief),
        active: active.map(brief),
        next: next.map(brief),
        inbox_count: stats.inbox ?? 0,
        waiting: waiting.map(brief),
        recently_completed: recentlyCompleted.map(brief),
        stats: {
          overdue: overdue.length,
          active: stats.active ?? 0,
          open: (stats.inbox ?? 0) + (stats.next ?? 0) + (stats.active ?? 0) + (stats.waiting ?? 0),
          done_today: (db.all<{ c: number }>("SELECT COUNT(*) as c FROM notes WHERE type='task' AND status='done' AND modified = ?", [todayStr])[0]?.c ?? 0),
          recurring: (db.all<{ c: number }>("SELECT COUNT(*) as c FROM notes WHERE type='task' AND recurrence IS NOT NULL AND recurrence != ''")[0]?.c ?? 0),
        },
      });
    }
  );

  // ── weekly_review ──
  server.registerTool(
    'weekly_review',
    {
      description: 'Get structured data for a GTD weekly review.',
      inputSchema: {},
    },
    async () => {
      const weekAgoStr = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const threeDaysAgoStr = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

      const staleWaiting = db.all<NoteRow>(
        "SELECT * FROM notes WHERE type='task' AND status='waiting' AND modified < ?",
        [weekAgoStr]
      );
      const oldInbox = db.all<NoteRow>(
        "SELECT * FROM notes WHERE type='task' AND status='inbox' AND created < ?",
        [threeDaysAgoStr]
      );
      const somedayCandidates = listTasks(db, { status: 'someday' });
      const completedThisWeek = db.all<NoteRow>(
        "SELECT * FROM notes WHERE type='task' AND status='done' AND modified >= ? ORDER BY modified DESC",
        [weekAgoStr]
      );

      // Projects without a next action
      const projectsWithNext = db.all<{ project: string }>(
        "SELECT DISTINCT project FROM notes WHERE type='task' AND status IN ('next','active') AND project IS NOT NULL"
      ).map(r => r.project);
      const allProjects = db.all<{ project: string }>(
        "SELECT DISTINCT project FROM notes WHERE type='task' AND project IS NOT NULL AND status NOT IN ('done','cancelled')"
      ).map(r => r.project);
      const projectsWithoutNext = allProjects.filter(p => !projectsWithNext.includes(p));

      const brief = (r: NoteRow) => ({
        path: r.path, title: r.title, status: r.status, priority: r.priority,
        due: r.due, project: r.project, modified: r.modified,
      });

      return ok({
        stale_waiting: staleWaiting.map(brief),
        old_inbox: oldInbox.map(brief),
        someday_candidates: somedayCandidates.map(brief),
        completed_this_week: completedThisWeek.map(brief),
        projects_without_next: projectsWithoutNext,
      });
    }
  );

  // ── archive_note ──
  server.registerTool(
    'archive_note',
    {
      description: 'Move a note to the archive directory.',
      inputSchema: {
        ref: z.string().describe('Path or shorthand'),
      },
    },
    async ({ ref }) => {
      const filePath = resolveRef(db, ref, globalPath, workspacePath || undefined);
      if (!filePath) return invalidRef(`Cannot resolve ref: ${ref}`);

      let raw: string;
      try {
        raw = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        return notFound(`File not found: ${filePath}`);
      }

      const { frontmatter, body } = parseFrontmatter(raw);
      const scope = scopeForPath(filePath);
      const root = rootForScope(scope);
      const store = scope === 'workspace' && workspaceStore ? workspaceStore : globalStore;

      const archiveDir = path.join(root, 'archive');
      await fs.promises.mkdir(archiveDir, { recursive: true });
      const slug = path.basename(filePath, '.md');
      const archivePath = await store.findAvailablePath(archiveDir, slug);

      try {
        await writeAndSync(archivePath, frontmatter, body);
        await fs.promises.unlink(filePath);
        dbDeleteNote(db, filePath);
        db.saveToDisk();
        return ok({ archived_path: archivePath });
      } catch (err) {
        return writeFailed(`Failed to archive: ${err}`);
      }
    }
  );

  // ── delete_note ──
  server.registerTool(
    'delete_note',
    {
      description: 'Permanently delete a note. Only works on archived files or cancelled tasks.',
      inputSchema: {
        ref: z.string().describe('Path or shorthand'),
      },
    },
    async ({ ref }) => {
      const filePath = resolveRef(db, ref, globalPath, workspacePath || undefined);
      if (!filePath) return invalidRef(`Cannot resolve ref: ${ref}`);

      // Guard: only archive/ files or cancelled tasks
      const isArchived = filePath.includes('/archive/');
      const row = getNote(db, filePath);
      const isCancelled = row?.status === 'cancelled';

      if (!isArchived && !isCancelled) {
        return validationError('Can only delete archived files or cancelled tasks. Archive or cancel first.');
      }

      try {
        await fs.promises.unlink(filePath);
        dbDeleteNote(db, filePath);
        db.saveToDisk();
        return ok({ deleted_path: filePath });
      } catch {
        return notFound(`File not found: ${filePath}`);
      }
    }
  );

  // --- Connect transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[Groundwork MCP] Server started\n');
}

main().catch(err => {
  process.stderr.write(`[Groundwork MCP] Fatal: ${err}\n`);
  process.exit(1);
});
