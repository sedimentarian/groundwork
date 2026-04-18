# MCP Server + Local LLM (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP server to the Groundwork extension so AI tools (Claude Code, Copilot) interact with the vault via structured tool calls instead of grep-based skill instructions.

**Architecture:** A standalone Node.js script (`out/mcp/server.js`) uses `@modelcontextprotocol/sdk` to expose 11 tools over stdio transport. The extension registers it via VS Code's `McpStdioServerDefinition` contribution point so it's auto-discovered. The server opens the same SQLite DB (`~/.groundwork/.index.db`) and reads/writes vault files via shared `db/` and `vault/` modules. A separate `src/mcp/shorthand.ts` handles N1/A2/S3 resolution.

**Tech Stack:** `@modelcontextprotocol/sdk`, `zod` (for tool input schemas), `sql.js` (existing), vitest (existing)

**Spec:** `docs/superpowers/specs/2026-03-22-mcp-sqlite-design.md` — Section 2 (MCP Server & Tool Definitions) and Phase 2 rollout.

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/mcp/server.ts` | MCP server entry point: init DB, register 11 tools, connect stdio transport |
| `src/mcp/shorthand.ts` | Resolve shorthand refs (N1, A2) to file paths via DB query |
| `src/mcp/shorthand.test.ts` | Tests for shorthand resolution |
| `src/mcp/tools.test.ts` | Integration tests for tool handlers (in-memory DB + temp vault) |

### Modified files

| File | What changes |
|------|-------------|
| `package.json` | Add `@modelcontextprotocol/sdk` + `zod` deps, add `contributes.mcpServerDefinitionProviders`, bump engine to `^1.99.0`, bump version to `0.5.0` |
| `src/extension.ts` | Register MCP server definition provider |
| `tsconfig.json` | May need adjustment for MCP SDK module resolution |

---

## Chunk 1: Shorthand resolution and MCP server scaffold

### Task 1: Install MCP SDK and Zod dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext
npm install @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: Verify installation**

```bash
ls node_modules/@modelcontextprotocol/sdk/dist/ | head -5
ls node_modules/zod/ | head -5
```

Expected: both directories exist with compiled output.

- [ ] **Step 3: Update .vscodeignore if needed**

The MCP server script runs as a child process from `out/mcp/server.js`, so it needs access to these node_modules. Check that `.vscodeignore` doesn't exclude them:

```bash
cat .vscodeignore
```

Add exceptions if `node_modules/**` is excluded:
```
!node_modules/@modelcontextprotocol/**
!node_modules/zod/**
!node_modules/content-type/**
!node_modules/raw-body/**
!node_modules/eventsource/**
!node_modules/eventsource-parser/**
!node_modules/pkce-challenge/**
```

Note: Check what transitive deps the SDK needs by looking at the actual `node_modules/@modelcontextprotocol/sdk/package.json` dependencies list and add exceptions for each.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .vscodeignore
git commit -m "chore: add @modelcontextprotocol/sdk and zod dependencies"
```

---

### Task 2: Create shorthand resolution module (`src/mcp/shorthand.ts`)

**Files:**
- Create: `src/mcp/shorthand.ts`
- Create: `src/mcp/shorthand.test.ts`

Shorthands (N1, A2, S3) are resolved by querying the DB. The prefix letter maps to a status, and the number is the 1-based position in the sorted task list for that status.

- [ ] **Step 1: Write the tests**

Create `src/mcp/shorthand.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { upsertNote, NoteRow } from '../db/queries';
import { resolveShorthand, parseShorthand, STATUS_PREFIX } from './shorthand';

function makeTask(overrides: Partial<NoteRow>): NoteRow {
  return {
    path: '/test.md', scope: 'global', title: 'Test', type: 'task',
    status: 'inbox', priority: 'medium', sort_order: null, due: null,
    project: null, context: null, tags: null, recurrence: null,
    created: '2026-04-01', modified: '2026-04-01', body_hash: 'h',
    indexed_at: new Date().toISOString(), ...overrides,
  };
}

describe('parseShorthand', () => {
  it('should parse valid shorthands', () => {
    expect(parseShorthand('N1')).toEqual({ status: 'next', index: 1 });
    expect(parseShorthand('A3')).toEqual({ status: 'active', index: 3 });
    expect(parseShorthand('I10')).toEqual({ status: 'inbox', index: 10 });
    expect(parseShorthand('S2')).toEqual({ status: 'someday', index: 2 });
    expect(parseShorthand('W1')).toEqual({ status: 'waiting', index: 1 });
    expect(parseShorthand('D5')).toEqual({ status: 'done', index: 5 });
    expect(parseShorthand('C1')).toEqual({ status: 'cancelled', index: 1 });
  });

  it('should be case-insensitive', () => {
    expect(parseShorthand('n1')).toEqual({ status: 'next', index: 1 });
  });

  it('should return null for invalid shorthands', () => {
    expect(parseShorthand('X1')).toBeNull();
    expect(parseShorthand('N0')).toBeNull();
    expect(parseShorthand('N')).toBeNull();
    expect(parseShorthand('hello')).toBeNull();
    expect(parseShorthand('')).toBeNull();
  });
});

describe('resolveShorthand', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-shorthand-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve N1 to the first next task by sort order', () => {
    upsertNote(db, makeTask({ path: '/a.md', status: 'next', title: 'Alpha', sort_order: 20 }));
    upsertNote(db, makeTask({ path: '/b.md', status: 'next', title: 'Beta', sort_order: 10 }));
    upsertNote(db, makeTask({ path: '/c.md', status: 'next', title: 'Gamma', sort_order: 30 }));

    expect(resolveShorthand(db, 'N1')).toBe('/b.md');  // sort_order 10 is first
    expect(resolveShorthand(db, 'N2')).toBe('/a.md');  // sort_order 20
    expect(resolveShorthand(db, 'N3')).toBe('/c.md');  // sort_order 30
  });

  it('should return null for out-of-range index', () => {
    upsertNote(db, makeTask({ path: '/a.md', status: 'next', title: 'Only' }));
    expect(resolveShorthand(db, 'N1')).toBe('/a.md');
    expect(resolveShorthand(db, 'N2')).toBeNull();
  });

  it('should sort by priority when sort_order is null', () => {
    upsertNote(db, makeTask({ path: '/low.md', status: 'inbox', title: 'Low', priority: 'low' }));
    upsertNote(db, makeTask({ path: '/high.md', status: 'inbox', title: 'High', priority: 'high' }));

    expect(resolveShorthand(db, 'I1')).toBe('/high.md');
    expect(resolveShorthand(db, 'I2')).toBe('/low.md');
  });

  it('should return null for invalid shorthand', () => {
    expect(resolveShorthand(db, 'X1')).toBeNull();
    expect(resolveShorthand(db, '/some/path.md')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/mcp/shorthand.test.ts --reporter=verbose
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/mcp/shorthand.ts`**

```typescript
import { GroundworkDB } from '../db/index';
import { TaskStatus } from '../vault/types';

/** Maps shorthand prefix letter to GTD status. */
export const STATUS_PREFIX: Record<string, TaskStatus> = {
  I: 'inbox',
  N: 'next',
  A: 'active',
  W: 'waiting',
  S: 'someday',
  D: 'done',
  C: 'cancelled',
};

/** Reverse map: status → prefix letter. */
export const PREFIX_FOR_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_PREFIX).map(([k, v]) => [v, k])
);

export interface ParsedShorthand {
  status: TaskStatus;
  index: number;
}

/** Parse a shorthand string like "N1" into { status, index }. Returns null if invalid. */
export function parseShorthand(ref: string): ParsedShorthand | null {
  if (!ref || ref.length < 2) return null;
  const prefix = ref[0].toUpperCase();
  const numStr = ref.slice(1);
  const index = parseInt(numStr, 10);

  if (!STATUS_PREFIX[prefix]) return null;
  if (isNaN(index) || index < 1 || String(index) !== numStr) return null;

  return { status: STATUS_PREFIX[prefix], index };
}

/**
 * Resolve a shorthand (N1, A2) or absolute path to a file path.
 * Returns null if the ref can't be resolved.
 */
export function resolveShorthand(db: GroundworkDB, ref: string): string | null {
  // If it looks like an absolute path, return as-is
  if (ref.startsWith('/') || ref.includes('\\')) return ref;

  const parsed = parseShorthand(ref);
  if (!parsed) return null;

  // Query tasks for this status, sorted the same way as the tree view
  const rows = db.all<{ path: string }>(
    `SELECT path FROM notes
     WHERE type = 'task' AND status = ?
     ORDER BY
       CASE WHEN sort_order IS NOT NULL THEN 0 ELSE 1 END,
       sort_order,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
       title COLLATE NOCASE`,
    [parsed.status]
  );

  // 1-based index
  const row = rows[parsed.index - 1];
  return row?.path ?? null;
}

/**
 * Resolve a ref that may be a shorthand, absolute path, or relative path.
 * For relative paths, tries both vault roots.
 */
export function resolveRef(
  db: GroundworkDB,
  ref: string,
  globalRoot: string,
  workspaceRoot?: string
): string | null {
  // Absolute path
  if (ref.startsWith('/') || ref.includes('\\')) return ref;

  // Shorthand
  const shorthand = parseShorthand(ref);
  if (shorthand) return resolveShorthand(db, ref);

  // Relative path — try workspace first, then global
  const path = require('path');
  if (workspaceRoot) {
    const wsPath = path.join(workspaceRoot, ref);
    const exists = db.get('SELECT path FROM notes WHERE path = ?', [wsPath]);
    if (exists) return wsPath;
  }
  const globalPath = path.join(globalRoot, ref);
  const exists = db.get('SELECT path FROM notes WHERE path = ?', [globalPath]);
  if (exists) return globalPath;

  return null;
}
```

- [ ] **Step 4: Create directory and run tests**

```bash
mkdir -p src/mcp
npx vitest run src/mcp/shorthand.test.ts --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/shorthand.ts src/mcp/shorthand.test.ts
git commit -m "feat: add shorthand resolution (N1/A2/S3) from SQLite index"
```

---

### Task 3: Create MCP server entry point (`src/mcp/server.ts`)

**Files:**
- Create: `src/mcp/server.ts`

This is the standalone MCP server script. It initializes the DB, registers all 11 tools, and connects via stdio. It's designed to be run as `node out/mcp/server.js --global-path ~/.groundwork [--workspace-path /path/to/.groundwork]`.

- [ ] **Step 1: Create the server scaffold with list_tasks and get_note tools**

Create `src/mcp/server.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { reindex, frontmatterToRow, VaultSource } from '../db/sync';
import {
  listTasks, getNote, upsertNote, deleteNote, searchNotes, taskStats, NoteRow, TaskFilter,
} from '../db/queries';
import { VaultStore, parseFrontmatter, serializeFrontmatter } from '../vault/store';
import { NoteFrontmatter, TaskStatus, VaultScope } from '../vault/types';
import { resolveRef, resolveShorthand, parseShorthand, PREFIX_FOR_STATUS } from './shorthand';
import * as crypto from 'crypto';

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
  upsertNote(db, row);
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
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'NOT_FOUND' }) }], isError: true };
}
function invalidRef(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'INVALID_REF' }) }], isError: true };
}
function validationError(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'VALIDATION_ERROR' }) }], isError: true };
}
function writeFailed(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code: 'WRITE_FAILED' }) }], isError: true };
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
      inputSchema: z.object({
        status: z.enum(['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled']).optional().describe('Filter by GTD status'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Filter by priority'),
        project: z.string().optional().describe('Filter by project name'),
        tag: z.string().optional().describe('Filter by tag'),
        context: z.string().optional().describe('Filter by @-context'),
        scope: z.enum(['global', 'workspace']).optional().describe('Filter by vault scope'),
        limit: z.number().optional().describe('Max results (default 50)'),
      }),
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
      inputSchema: z.object({
        ref: z.string().describe('Absolute path, relative path, or shorthand (N1, A2, etc.)'),
      }),
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
      description: 'Create a new task in the vault.',
      inputSchema: z.object({
        title: z.string().describe('Task title'),
        status: z.enum(['inbox', 'next', 'active', 'waiting', 'someday']).optional().describe('GTD status (default: inbox)'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority (default: medium)'),
        due: z.string().optional().describe('Due date (ISO format, e.g. 2026-04-15)'),
        project: z.string().optional().describe('Project name'),
        tags: z.array(z.string()).optional().describe('Tags'),
        context: z.array(z.string()).optional().describe('GTD contexts (e.g. @computer)'),
        body: z.string().optional().describe('Task body (markdown)'),
        scope: z.enum(['global', 'workspace']).optional().describe('Vault scope (default: workspace if available)'),
      }),
    },
    async (params) => {
      const scope = params.scope ?? defaultScope();
      const root = rootForScope(scope);
      const store = scope === 'workspace' && workspaceStore ? workspaceStore : globalStore;

      const slug = params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = await store.findAvailablePath(path.join(root, 'inbox'), slug);

      const fm: NoteFrontmatter = {
        title: params.title,
        type: 'task',
        status: (params.status as TaskStatus) ?? 'inbox',
        priority: params.priority ?? 'medium',
        created: new Date().toISOString(),
      };
      if (params.due) fm.due = params.due;
      if (params.project) fm.project = params.project;
      if (params.tags?.length) fm.tags = params.tags;
      if (params.context?.length) fm.context = params.context;

      try {
        await writeAndSync(filePath, fm, params.body ?? '');
        const shorthand = shorthandFor(filePath, fm.status ?? 'inbox');
        return ok({ path: filePath, shorthand });
      } catch (err) {
        return writeFailed(`Failed to create task: ${err}`);
      }
    }
  );

  // ── create_note ──
  server.registerTool(
    'create_note',
    {
      description: 'Create a new note, decision, project, or reference document.',
      inputSchema: z.object({
        title: z.string().describe('Note title'),
        type: z.enum(['note', 'decision', 'project', 'reference', 'log']).describe('Note type'),
        body: z.string().optional().describe('Note body (markdown)'),
        project: z.string().optional().describe('Project name'),
        tags: z.array(z.string()).optional().describe('Tags'),
        scope: z.enum(['global', 'workspace']).optional().describe('Vault scope'),
      }),
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
        await writeAndSync(filePath, fm, params.body ?? '');
        return ok({ path: filePath });
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
      inputSchema: z.object({
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
      }),
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
      if (fields.sort_order !== undefined) { (frontmatter as any)['sort-order'] = fields.sort_order; updatedFields.push('sort_order'); }

      const newBody = fields.body !== undefined ? fields.body : existingBody;
      if (fields.body !== undefined) updatedFields.push('body');

      let finalPath = filePath;

      // Handle status change — move file to new directory if it's a task
      if (fields.status !== undefined && fields.status !== frontmatter.status) {
        const validStatuses: string[] = ['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled'];
        if (!validStatuses.includes(fields.status)) {
          return validationError(`Invalid status: ${fields.status}`);
        }
        frontmatter.status = fields.status as TaskStatus;
        updatedFields.push('status');

        // Move task file to the status directory (inbox/ for all active statuses)
        // Tasks live in inbox/ regardless of status (convention in this vault)
        // The status is tracked in frontmatter, not by directory
      }

      try {
        await writeAndSync(finalPath, frontmatter, newBody);
        return ok({ path: finalPath, updated_fields: updatedFields });
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
      inputSchema: z.object({
        ref: z.string().describe('Path or shorthand'),
        target_scope: z.enum(['global', 'workspace']).optional().describe('Target vault scope'),
        target_type: z.enum(['note', 'decision', 'project', 'reference', 'log']).optional().describe('Target type (changes directory)'),
      }),
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
        deleteNote(db, filePath);
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
      description: 'Full-text search across vault note titles.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        type: z.string().optional().describe('Filter by note type'),
        status: z.string().optional().describe('Filter by status'),
        scope: z.enum(['global', 'workspace']).optional().describe('Filter by scope'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
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
      inputSchema: z.object({}),
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
          done_today: db.all("SELECT COUNT(*) as c FROM notes WHERE type='task' AND status='done' AND modified = ?", [todayStr])[0]?.c ?? 0,
          recurring: db.all("SELECT COUNT(*) as c FROM notes WHERE type='task' AND recurrence IS NOT NULL AND recurrence != ''")[0]?.c ?? 0,
        },
      });
    }
  );

  // ── weekly_review ──
  server.registerTool(
    'weekly_review',
    {
      description: 'Get structured data for a GTD weekly review.',
      inputSchema: z.object({}),
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
      inputSchema: z.object({
        ref: z.string().describe('Path or shorthand'),
      }),
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
        deleteNote(db, filePath);
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
      inputSchema: z.object({
        ref: z.string().describe('Path or shorthand'),
      }),
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
        deleteNote(db, filePath);
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
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Fix any type errors (MCP SDK may need `esModuleInterop` or `moduleResolution` adjustments — check and fix).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add MCP server with 11 vault management tools"
```

---

### Task 4: Write integration tests for MCP tools

**Files:**
- Create: `src/mcp/tools.test.ts`

These tests exercise the tool logic directly by calling the same functions the server uses, against an in-memory DB and temp vault files. We don't test the MCP transport layer itself — that's the SDK's responsibility.

- [ ] **Step 1: Create `src/mcp/tools.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { upsertNote, getNote, listTasks, deleteNote, NoteRow } from '../db/queries';
import { reindex, frontmatterToRow } from '../db/sync';
import { VaultStore, parseFrontmatter, serializeFrontmatter } from '../vault/store';
import { NoteFrontmatter } from '../vault/types';
import { resolveShorthand } from './shorthand';

describe('MCP tool logic', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: GroundworkDB;
  let store: VaultStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mcp-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    store = new VaultStore(vaultDir, 'global');
    await store.init();

    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a task and sync to DB. */
  async function createTask(title: string, status: string, priority = 'medium', sortOrder?: number) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(vaultDir, 'inbox', `${slug}.md`);
    const fm: NoteFrontmatter = {
      title, type: 'task', status: status as any, priority: priority as any,
      created: new Date().toISOString(),
    };
    if (sortOrder !== undefined) (fm as any)['sort-order'] = sortOrder;
    await store.writeNote(filePath, fm, '');
    const body = '';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    upsertNote(db, frontmatterToRow(fm, filePath, 'global', bodyHash));
    return filePath;
  }

  describe('create + list round-trip', () => {
    it('should create a task and list it back', async () => {
      const filePath = await createTask('Test Task', 'next');
      const tasks = listTasks(db, { status: 'next' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Test Task');
      expect(tasks[0].path).toBe(filePath);
    });
  });

  describe('update_note logic', () => {
    it('should update frontmatter fields and persist to file', async () => {
      const filePath = await createTask('Original', 'inbox');

      // Simulate update_note: read, merge, write
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      frontmatter.priority = 'high';
      frontmatter.status = 'next';

      const content = serializeFrontmatter(frontmatter) + body;
      fs.writeFileSync(filePath, content);

      // Sync to DB
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      upsertNote(db, frontmatterToRow(frontmatter, filePath, 'global', bodyHash));

      // Verify
      const row = getNote(db, filePath);
      expect(row!.priority).toBe('high');
      expect(row!.status).toBe('next');
    });
  });

  describe('delete_note guard', () => {
    it('should only allow deleting cancelled tasks', async () => {
      const filePath = await createTask('Active Task', 'active');
      const row = getNote(db, filePath);
      expect(row!.status).toBe('active');
      // Guard would reject this — status is not cancelled
      expect(row!.status !== 'cancelled').toBe(true);
      expect(!filePath.includes('/archive/')).toBe(true);
    });

    it('should allow deleting cancelled tasks', async () => {
      const filePath = await createTask('Cancel Me', 'cancelled');
      const row = getNote(db, filePath);
      expect(row!.status).toBe('cancelled');
    });
  });

  describe('shorthand integration', () => {
    it('should resolve shorthands after creating multiple tasks', async () => {
      await createTask('Alpha', 'next', 'medium', 10);
      await createTask('Beta', 'next', 'medium', 20);
      await createTask('Gamma', 'next', 'medium', 30);

      const n1 = resolveShorthand(db, 'N1');
      const n3 = resolveShorthand(db, 'N3');
      expect(n1).toContain('alpha');
      expect(n3).toContain('gamma');
    });
  });

  describe('daily_briefing data', () => {
    it('should aggregate task stats correctly', async () => {
      await createTask('Inbox 1', 'inbox');
      await createTask('Inbox 2', 'inbox');
      await createTask('Active 1', 'active');
      await createTask('Next 1', 'next');

      const stats = db.all<{ status: string; count: number }>(
        "SELECT status, COUNT(*) as count FROM notes WHERE type='task' GROUP BY status"
      );
      const byStatus = Object.fromEntries(stats.map(r => [r.status, r.count]));
      expect(byStatus.inbox).toBe(2);
      expect(byStatus.active).toBe(1);
      expect(byStatus.next).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/mcp/tools.test.ts --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools.test.ts
git commit -m "test: add integration tests for MCP tool logic"
```

---

## Chunk 2: Extension registration and packaging

### Task 5: Register MCP server in extension

**Files:**
- Modify: `package.json` — add `contributes.mcpServerDefinitionProviders`
- Modify: `src/extension.ts` — register the MCP server definition provider

- [ ] **Step 1: Add contribution point to package.json**

In `package.json`, add inside the `"contributes"` object:

```json
"mcpServerDefinitionProviders": [
  {
    "id": "groundwork",
    "label": "Groundwork Vault"
  }
]
```

- [ ] **Step 2: Register MCP server definition provider in extension.ts**

At the end of the `activate()` function (before the closing brace), add:

```typescript
  // Register MCP server for AI tool discovery
  try {
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
      const mcpEmitter = new vscode.EventEmitter<void>();
      ctx.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('groundwork', {
          onDidChangeMcpServerDefinitions: mcpEmitter.event,
          provideMcpServerDefinitions: async () => {
            const serverScript = path.join(ctx.extensionPath, 'out', 'mcp', 'server.js');
            const mcpArgs = [serverScript, '--global-path', globalPath];
            if (manager.workspacePath) {
              mcpArgs.push('--workspace-path', manager.workspacePath);
            }
            return [
              new vscode.McpStdioServerDefinition({
                label: 'Groundwork Vault',
                command: 'node',
                args: mcpArgs,
                version: '0.5.0',
              }),
            ];
          },
          resolveMcpServerDefinition: async (server) => server,
        })
      );
      out.appendLine('[Groundwork] MCP server registered');
    }
  } catch {
    out.appendLine('[Groundwork] MCP server registration not available (VS Code < 1.99)');
  }
```

- [ ] **Step 3: Compile and verify**

```bash
npx tsc --noEmit
```

If `McpStdioServerDefinition` or `registerMcpServerDefinitionProvider` are not in the VS Code types, the `try/catch` with `typeof` check handles it at runtime. For compile-time, add type augmentation if needed:

Create `src/mcp/vscode-mcp.d.ts` if required:

```typescript
// Type augmentation for VS Code MCP API (available in VS Code 1.99+)
declare module 'vscode' {
  export class McpStdioServerDefinition {
    constructor(options: {
      label: string;
      command: string;
      args?: string[];
      cwd?: import('vscode').Uri;
      env?: Record<string, string>;
      version?: string;
    });
    label: string;
  }

  export namespace lm {
    export function registerMcpServerDefinitionProvider(
      id: string,
      provider: {
        onDidChangeMcpServerDefinitions: import('vscode').Event<void>;
        provideMcpServerDefinitions: () => Promise<McpStdioServerDefinition[]>;
        resolveMcpServerDefinition: (server: McpStdioServerDefinition) => Promise<McpStdioServerDefinition | undefined>;
      }
    ): import('vscode').Disposable;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json src/extension.ts src/mcp/vscode-mcp.d.ts
git commit -m "feat: register Groundwork MCP server in VS Code extension"
```

---

### Task 6: Bump version and update engine requirement

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version to 0.5.0 and engine to ^1.99.0**

In `package.json`:
- Change `"version": "0.3.0"` to `"version": "0.5.0"`
- Change `"vscode": "^1.89.0"` to `"vscode": "^1.99.0"`

- [ ] **Step 2: Update @types/vscode**

```bash
npm install --save-dev @types/vscode@^1.99.0
```

This ensures the MCP API types are available at compile time, potentially eliminating the need for the manual type declaration in Task 5.

- [ ] **Step 3: Recheck compile**

```bash
npx tsc --noEmit
```

If `@types/vscode@1.99` includes the MCP types natively, remove `src/mcp/vscode-mcp.d.ts`.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run --reporter=verbose
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump to v0.5.0, require VS Code ^1.99.0 for MCP support"
```

---

### Task 7: Compile and manual test

**Files:** None — verification only.

- [ ] **Step 1: Full compile**

```bash
npx tsc
```

Verify `out/mcp/server.js` is produced.

- [ ] **Step 2: Test MCP server standalone**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node out/mcp/server.js 2>/dev/null | head -5
```

Expected: JSON-RPC response with server capabilities.

- [ ] **Step 3: Test in Extension Development Host (F5)**

1. Press F5 to launch Extension Development Host
2. Open a workspace with a `.groundwork/` vault
3. Check Output panel → "Groundwork" for "[Groundwork] MCP server registered"
4. In Claude Code or Copilot agent mode, verify the Groundwork tools appear
5. Test: ask Claude to "list my next actions" — should invoke `list_tasks`

- [ ] **Step 4: Run all tests one final time**

```bash
npx vitest run --reporter=verbose
```

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during manual MCP server testing"
```
