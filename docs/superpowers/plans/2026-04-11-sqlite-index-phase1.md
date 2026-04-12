# SQLite Index Layer (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite index to the Groundwork VS Code extension so that all metadata queries hit a local DB instead of re-reading every markdown file on every refresh.

**Architecture:** A `sql.js` (WASM) database at `~/.groundwork/.index.db` caches all vault frontmatter. A startup reindex syncs DB from files; a `FileSystemWatcher` keeps it current at runtime. `VaultStore.writeNote()` gains write-through so internal writes update both file and DB atomically. Tree views and briefing panel switch from `queryNotes()` (reads every file) to parameterized SQL queries.

**Tech Stack:** `sql.js` (SQLite via WASM), vitest (existing test runner), TypeScript strict mode (existing)

**Spec:** `docs/superpowers/specs/2026-03-22-mcp-sqlite-design.md` — this plan implements Section 1 (SQLite Schema & Sync) and Section 3 (Extension View Integration) only. MCP server (Section 2) and local LLM are Phase 2.

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/db/index.ts` | DB lifecycle: open, close, save to disk, load WASM |
| `src/db/schema.ts` | CREATE TABLE/INDEX/FTS statements, schema version check |
| `src/db/queries.ts` | Typed query functions: `listTasks()`, `getNote()`, `stats()`, `search()`, `upsertNote()`, `deleteNote()` |
| `src/db/sync.ts` | Startup reindex, file watcher setup, write-through helper, frontmatter key mapping |
| `src/db/queries.test.ts` | Unit tests for all query functions (in-memory DB) |
| `src/db/sync.test.ts` | Unit tests for reindex and key mapping |

### Modified files

| File | What changes |
|------|-------------|
| `src/vault/types.ts` | Add typed `recurrence` and `recurrenceAnchor` fields to `NoteFrontmatter` |
| `src/vault/store.ts` | `writeNote()` gains optional DB write-through callback; no other changes |
| `src/vault/manager.ts` | Accept and expose a `db` instance; wire write-through on both stores |
| `src/views/task-tree.ts` | `getChildren()` queries DB instead of `manager.queryNotes()` |
| `src/views/vault-tree.ts` | File metadata (title, type) from DB instead of `quickReadMeta()` per file |
| `src/views/briefing-panel.ts` | Stats and task lists from DB queries instead of reading all files |
| `src/extension.ts` | Init DB + file watcher in `activate()`, pass DB to views |
| `package.json` | Add `sql.js` dependency, add WASM to `files` array |
| `tsconfig.json` | No changes expected (sql.js ships its own types) |

---

## Chunk 1: Foundation — DB lifecycle, schema, and basic queries

### Task 1: Add sql.js dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install sql.js**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext
npm install sql.js
```

- [ ] **Step 2: Verify WASM binary location**

```bash
ls node_modules/sql.js/dist/sql-wasm.wasm
```

Expected: file exists. This is the ~1.2MB WASM binary that sql.js loads at runtime.

- [ ] **Step 3: Add WASM to vsix packaging**

In `package.json`, ensure the `files` array (if present) or `.vscodeignore` allows `node_modules/sql.js/dist/sql-wasm.wasm`. Check current `.vscodeignore`:

```bash
cat .vscodeignore 2>/dev/null || echo "no .vscodeignore"
```

If `.vscodeignore` excludes `node_modules/`, add an exception line:
```
!node_modules/sql.js/dist/sql-wasm.wasm
!node_modules/sql.js/dist/sql-wasm.js
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .vscodeignore
git commit -m "chore: add sql.js dependency for SQLite index"
```

---

### Task 2: Add typed recurrence fields to NoteFrontmatter

**Files:**
- Modify: `src/vault/types.ts:2-14`

The spec notes that `recurrence` and `recurrence-anchor` currently survive via the `[key: string]: unknown` index signature. Add them as typed optional fields so the DB schema can reference them directly.

- [ ] **Step 1: Write the test**

Add to `src/vault/store.test.ts` — a test that verifies recurrence fields survive frontmatter round-trip:

```typescript
it('should preserve recurrence fields in frontmatter', () => {
  const raw = [
    '---',
    'title: Daily standup',
    'type: task',
    'status: active',
    'recurrence: weekday',
    'recurrence-anchor: 2026-04-01',
    '---',
    'Stand up and stretch.',
  ].join('\n');

  const { frontmatter, body } = parseFrontmatter(raw);
  expect(frontmatter.recurrence).toBe('weekday');
  expect(frontmatter['recurrence-anchor']).toBe('2026-04-01');
  expect(body).toBe('Stand up and stretch.');
});
```

- [ ] **Step 2: Run test to verify it passes** (it should already pass due to index signature)

```bash
npx vitest run src/vault/store.test.ts --reporter=verbose
```

Expected: PASS — the index signature already captures these fields.

- [ ] **Step 3: Add typed fields to NoteFrontmatter**

In `src/vault/types.ts`, add inside the `NoteFrontmatter` interface (before the index signature line):

```typescript
  recurrence?: string;         // daily | weekday | weekly | monthly | quarterly
  'recurrence-anchor'?: string; // ISO date — anchor for interval calculation
  'sort-order'?: number;       // Numeric sort key for custom ordering
```

- [ ] **Step 4: Run tests to confirm nothing breaks**

```bash
npx vitest run --reporter=verbose
```

Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/types.ts src/vault/store.test.ts
git commit -m "feat: add typed recurrence and sort-order fields to NoteFrontmatter"
```

---

### Task 3: Create DB lifecycle module (`src/db/index.ts`)

**Files:**
- Create: `src/db/index.ts`

This module handles loading the WASM binary, opening/creating the database, saving to disk, and closing. It wraps `sql.js` so no other module imports `sql.js` directly.

- [ ] **Step 1: Write the test**

Create `src/db/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';

describe('GroundworkDB', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-db-test-'));
    dbPath = path.join(tmpDir, '.index.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should open a new database when no file exists', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it('should persist and reload data across open/close', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    db.saveToDisk();
    db.close();

    // Reopen
    const db2 = new GroundworkDB(dbPath);
    await db2.open();
    const rows = db2.all<{ id: number; name: string }>('SELECT * FROM test');
    expect(rows).toEqual([{ id: 1, name: 'hello' }]);
    db2.close();
  });

  it('should create a fresh DB if file is missing', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    // Should not throw — creates fresh in-memory DB
    db.run('CREATE TABLE test (val TEXT)');
    expect(db.isOpen).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/db/index.test.ts --reporter=verbose
```

Expected: FAIL — `GroundworkDB` does not exist yet.

- [ ] **Step 3: Implement `src/db/index.ts`**

```typescript
import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export class GroundworkDB {
  private db: Database | null = null;

  constructor(private dbPath: string) {}

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open or create the database. Loads WASM on first call. */
  async open(): Promise<void> {
    if (!SQL) {
      // Locate WASM binary relative to this file (works in both dev and packaged extension)
      const wasmPaths = [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ];
      let wasmBinary: Buffer | undefined;
      for (const p of wasmPaths) {
        try {
          wasmBinary = fs.readFileSync(p);
          break;
        } catch { /* try next */ }
      }
      SQL = await initSqlJs(wasmBinary ? { wasmBinary } : undefined);
    }

    try {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.db = new SQL.Database();
    }
  }

  /** Execute a SQL statement (no return value). */
  run(sql: string, params?: unknown[]): void {
    this.assertOpen();
    this.db!.run(sql, params as any[]);
  }

  /** Execute a query and return all rows as typed objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this.assertOpen();
    const stmt = this.db!.prepare(sql);
    if (params) stmt.bind(params as any[]);

    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  /** Execute a query and return the first row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const rows = this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Save the in-memory database to disk. */
  saveToDisk(): void {
    this.assertOpen();
    const data = this.db!.export();
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private assertOpen(): void {
    if (!this.db) throw new Error('Database is not open. Call open() first.');
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/db/index.test.ts --reporter=verbose
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/db/index.test.ts
git commit -m "feat: add GroundworkDB lifecycle wrapper around sql.js"
```

---

### Task 4: Create schema module (`src/db/schema.ts`)

**Files:**
- Create: `src/db/schema.ts`

This module defines the `notes` table, indexes, FTS virtual table, triggers, and the `meta` table for schema versioning. It also handles the "drop and rebuild" migration strategy.

- [ ] **Step 1: Write the test**

Create `src/db/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema, SCHEMA_VERSION } from './schema';

describe('schema', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-schema-test-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create notes table with all expected columns', () => {
    initSchema(db);

    // Insert a row to verify columns exist
    db.run(
      `INSERT INTO notes (path, scope, title, type, status, priority, sort_order, due, project, context, tags, recurrence, created, modified, body_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['/test.md', 'global', 'Test', 'task', 'inbox', 'high', 10, '2026-04-01', 'MyProject', '["@computer"]', '["api"]', 'daily', '2026-04-01', '2026-04-01', 'abc123', new Date().toISOString()]
    );

    const row = db.get<Record<string, unknown>>('SELECT * FROM notes WHERE path = ?', ['/test.md']);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Test');
    expect(row!.sort_order).toBe(10);
    expect(row!.scope).toBe('global');
  });

  it('should create meta table with schema version', () => {
    initSchema(db);

    const meta = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    expect(meta).not.toBeNull();
    expect(meta!.value).toBe(String(SCHEMA_VERSION));
  });

  it('should create FTS virtual table', () => {
    initSchema(db);

    db.run(
      `INSERT INTO notes (path, scope, title, type, status, body_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['/fts-test.md', 'global', 'Search Me', 'note', 'inbox', 'hash1', new Date().toISOString()]
    );

    const results = db.all<{ path: string }>('SELECT path FROM notes_fts WHERE notes_fts MATCH ?', ['Search']);
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('/fts-test.md');
  });

  it('should rebuild schema if version mismatches', () => {
    initSchema(db);

    // Simulate old schema version
    db.run("UPDATE meta SET value = '0' WHERE key = 'schema_version'");

    // Re-init should drop and rebuild
    initSchema(db);

    const meta = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    expect(meta!.value).toBe(String(SCHEMA_VERSION));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/db/schema.test.ts --reporter=verbose
```

Expected: FAIL — `initSchema` does not exist.

- [ ] **Step 3: Implement `src/db/schema.ts`**

```typescript
import { GroundworkDB } from './index';

export const SCHEMA_VERSION = 1;

const NOTES_TABLE = `
CREATE TABLE IF NOT EXISTS notes (
  path          TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  title         TEXT,
  type          TEXT,
  status        TEXT,
  priority      TEXT,
  sort_order    INTEGER,
  due           TEXT,
  project       TEXT,
  context       TEXT,
  tags          TEXT,
  recurrence    TEXT,
  created       TEXT,
  modified      TEXT,
  body_hash     TEXT,
  indexed_at    TEXT,
  schema_version INTEGER DEFAULT ${SCHEMA_VERSION}
)`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_type_status ON notes(type, status)',
  'CREATE INDEX IF NOT EXISTS idx_due ON notes(due)',
  'CREATE INDEX IF NOT EXISTS idx_project ON notes(project)',
  'CREATE INDEX IF NOT EXISTS idx_scope ON notes(scope)',
];

const FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path,
  title,
  body,
  content='notes',
  content_rowid='rowid'
)`;

const FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, path, title, body)
      VALUES (new.rowid, new.path, new.title, '');
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body)
      VALUES ('delete', old.rowid, old.path, old.title, '');
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body)
      VALUES ('delete', old.rowid, old.path, old.title, '');
    INSERT INTO notes_fts(rowid, path, title, body)
      VALUES (new.rowid, new.path, new.title, '');
  END`,
];

const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`;

/** Initialize or rebuild the schema. Drops and recreates if version mismatches. */
export function initSchema(db: GroundworkDB): void {
  // Check existing schema version
  try {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    if (row && Number(row.value) === SCHEMA_VERSION) {
      return; // Schema is current
    }
    // Version mismatch — drop everything and rebuild
    dropAll(db);
  } catch {
    // meta table doesn't exist — fresh DB
  }

  db.run(NOTES_TABLE);
  for (const idx of INDEXES) db.run(idx);
  db.run(FTS_TABLE);
  for (const trigger of FTS_TRIGGERS) db.run(trigger);
  db.run(META_TABLE);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}

function dropAll(db: GroundworkDB): void {
  // Drop in reverse dependency order
  db.run('DROP TRIGGER IF EXISTS notes_ai');
  db.run('DROP TRIGGER IF EXISTS notes_ad');
  db.run('DROP TRIGGER IF EXISTS notes_au');
  db.run('DROP TABLE IF EXISTS notes_fts');
  db.run('DROP TABLE IF EXISTS notes');
  db.run('DROP TABLE IF EXISTS meta');
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/db/schema.test.ts --reporter=verbose
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/schema.test.ts
git commit -m "feat: add SQLite schema with notes table, FTS, and version management"
```

---

### Task 5: Create queries module (`src/db/queries.ts`)

**Files:**
- Create: `src/db/queries.ts`

Typed query functions that the rest of the extension calls. These replace the file-reading code paths.

- [ ] **Step 1: Write the tests**

Create `src/db/queries.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema } from './schema';
import { upsertNote, deleteNote, listTasks, getNote, taskStats, searchNotes, NoteRow } from './queries';

function makeRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: '/test/task.md',
    scope: 'global',
    title: 'Test Task',
    type: 'task',
    status: 'inbox',
    priority: 'medium',
    sort_order: null,
    due: null,
    project: null,
    context: null,
    tags: null,
    recurrence: null,
    created: '2026-04-01',
    modified: '2026-04-01',
    body_hash: 'abc',
    indexed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('queries', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-queries-test-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('upsertNote', () => {
    it('should insert a new row', () => {
      upsertNote(db, makeRow());
      const row = db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Test Task');
    });

    it('should update an existing row', () => {
      upsertNote(db, makeRow());
      upsertNote(db, makeRow({ title: 'Updated' }));
      const row = db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row!.title).toBe('Updated');
    });
  });

  describe('deleteNote', () => {
    it('should remove a row by path', () => {
      upsertNote(db, makeRow());
      deleteNote(db, '/test/task.md');
      const row = db.get('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('should return tasks filtered by status', () => {
      upsertNote(db, makeRow({ path: '/a.md', status: 'next', title: 'A' }));
      upsertNote(db, makeRow({ path: '/b.md', status: 'inbox', title: 'B' }));
      upsertNote(db, makeRow({ path: '/c.md', status: 'next', title: 'C' }));

      const next = listTasks(db, { status: 'next' });
      expect(next.length).toBe(2);
      expect(next.map(r => r.title)).toEqual(['A', 'C']);
    });

    it('should sort by sort_order, then priority, then title', () => {
      upsertNote(db, makeRow({ path: '/a.md', title: 'Z', sort_order: 10, priority: 'low' }));
      upsertNote(db, makeRow({ path: '/b.md', title: 'A', sort_order: null, priority: 'high' }));
      upsertNote(db, makeRow({ path: '/c.md', title: 'M', sort_order: null, priority: 'high' }));

      const tasks = listTasks(db, {});
      expect(tasks.map(r => r.title)).toEqual(['Z', 'A', 'M']);
    });

    it('should filter by project', () => {
      upsertNote(db, makeRow({ path: '/a.md', project: 'Alpha' }));
      upsertNote(db, makeRow({ path: '/b.md', project: 'Beta' }));

      const alpha = listTasks(db, { project: 'Alpha' });
      expect(alpha.length).toBe(1);
      expect(alpha[0].project).toBe('Alpha');
    });

    it('should filter by tag (JSON array contains)', () => {
      upsertNote(db, makeRow({ path: '/a.md', tags: '["api","backend"]' }));
      upsertNote(db, makeRow({ path: '/b.md', tags: '["frontend"]' }));

      const api = listTasks(db, { tag: 'api' });
      expect(api.length).toBe(1);
    });
  });

  describe('taskStats', () => {
    it('should return counts grouped by status', () => {
      upsertNote(db, makeRow({ path: '/a.md', status: 'inbox' }));
      upsertNote(db, makeRow({ path: '/b.md', status: 'inbox' }));
      upsertNote(db, makeRow({ path: '/c.md', status: 'next' }));
      upsertNote(db, makeRow({ path: '/d.md', type: 'note' })); // not a task

      const stats = taskStats(db);
      expect(stats.inbox).toBe(2);
      expect(stats.next).toBe(1);
      expect(stats.active).toBe(0);
    });
  });

  describe('searchNotes', () => {
    it('should find notes by title via FTS', () => {
      upsertNote(db, makeRow({ path: '/a.md', title: 'Deploy the API' }));
      upsertNote(db, makeRow({ path: '/b.md', title: 'Write docs' }));

      const results = searchNotes(db, 'API');
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('/a.md');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/db/queries.test.ts --reporter=verbose
```

Expected: FAIL — `queries.ts` does not exist.

- [ ] **Step 3: Implement `src/db/queries.ts`**

```typescript
import { GroundworkDB } from './index';

/** Shape of a row in the notes table. */
export interface NoteRow {
  path: string;
  scope: string;
  title: string | null;
  type: string | null;
  status: string | null;
  priority: string | null;
  sort_order: number | null;
  due: string | null;
  project: string | null;
  context: string | null;   // JSON array string
  tags: string | null;       // JSON array string
  recurrence: string | null;
  created: string | null;
  modified: string | null;
  body_hash: string | null;
  indexed_at: string | null;
}

export interface TaskFilter {
  status?: string;
  priority?: string;
  project?: string;
  scope?: string;
  tag?: string;
  context?: string;
  limit?: number;
}

/** Insert or update a note row. */
export function upsertNote(db: GroundworkDB, row: NoteRow): void {
  db.run(
    `INSERT OR REPLACE INTO notes
     (path, scope, title, type, status, priority, sort_order, due, project, context, tags, recurrence, created, modified, body_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.path, row.scope, row.title, row.type, row.status, row.priority,
      row.sort_order, row.due, row.project, row.context, row.tags, row.recurrence,
      row.created, row.modified, row.body_hash, row.indexed_at,
    ]
  );
}

/** Delete a note row by path. */
export function deleteNote(db: GroundworkDB, notePath: string): void {
  db.run('DELETE FROM notes WHERE path = ?', [notePath]);
}

/** List tasks with optional filters. Sorted by sort_order, priority, title. */
export function listTasks(db: GroundworkDB, filter: TaskFilter): NoteRow[] {
  const clauses: string[] = ["type = 'task'"];
  const params: unknown[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.priority) {
    clauses.push('priority = ?');
    params.push(filter.priority);
  }
  if (filter.project) {
    clauses.push('project = ?');
    params.push(filter.project);
  }
  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.tag) {
    // JSON array contains — tags is stored as '["api","backend"]'
    clauses.push("tags LIKE '%' || ? || '%'");
    params.push(`"${filter.tag}"`);
  }
  if (filter.context) {
    clauses.push("context LIKE '%' || ? || '%'");
    params.push(`"${filter.context}"`);
  }

  const where = clauses.join(' AND ');
  const limit = filter.limit ?? 500;

  // Priority sort: high=0, medium=1, low=2, null=1
  return db.all<NoteRow>(
    `SELECT * FROM notes
     WHERE ${where}
     ORDER BY
       CASE WHEN sort_order IS NOT NULL THEN 0 ELSE 1 END,
       sort_order,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
       title COLLATE NOCASE
     LIMIT ?`,
    [...params, limit]
  );
}

/** Get a single note by path. */
export function getNote(db: GroundworkDB, notePath: string): NoteRow | null {
  return db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', [notePath]);
}

/** Get all notes of a given type. */
export function listByType(db: GroundworkDB, type: string, scope?: string): NoteRow[] {
  if (scope) {
    return db.all<NoteRow>(
      'SELECT * FROM notes WHERE type = ? AND scope = ? ORDER BY title COLLATE NOCASE',
      [type, scope]
    );
  }
  return db.all<NoteRow>(
    'SELECT * FROM notes WHERE type = ? ORDER BY title COLLATE NOCASE',
    [type]
  );
}

/** Get metadata for all notes (used by vault tree for icon/title lookup). */
export function allNoteMetadata(db: GroundworkDB, scope?: string): NoteRow[] {
  if (scope) {
    return db.all<NoteRow>('SELECT * FROM notes WHERE scope = ?', [scope]);
  }
  return db.all<NoteRow>('SELECT * FROM notes');
}

/** Count tasks grouped by status. */
export function taskStats(db: GroundworkDB): Record<string, number> {
  const rows = db.all<{ status: string; count: number }>(
    "SELECT status, COUNT(*) as count FROM notes WHERE type = 'task' GROUP BY status"
  );
  const stats: Record<string, number> = {
    inbox: 0, next: 0, active: 0, waiting: 0, someday: 0, done: 0, cancelled: 0,
  };
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats;
}

/** Full-text search across note titles. */
export function searchNotes(db: GroundworkDB, query: string, filter?: { type?: string; status?: string; scope?: string }, limit = 20): NoteRow[] {
  // FTS5 query — escape double quotes in user input
  const ftsQuery = query.replace(/"/g, '""');
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.type) {
    clauses.push('n.type = ?');
    params.push(filter.type);
  }
  if (filter?.status) {
    clauses.push('n.status = ?');
    params.push(filter.status);
  }
  if (filter?.scope) {
    clauses.push('n.scope = ?');
    params.push(filter.scope);
  }

  const whereExtra = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

  return db.all<NoteRow>(
    `SELECT n.* FROM notes n
     JOIN notes_fts fts ON n.rowid = fts.rowid
     WHERE notes_fts MATCH ?${whereExtra}
     LIMIT ?`,
    [`"${ftsQuery}"`, ...params, limit]
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/db/queries.test.ts --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts src/db/queries.test.ts
git commit -m "feat: add typed query functions for SQLite note index"
```

---

### Task 6: Create sync module (`src/db/sync.ts`)

**Files:**
- Create: `src/db/sync.ts`

Handles the startup reindex (walk vault directories, compare mtimes, upsert/delete) and the frontmatter-to-DB field mapping (`sort-order` → `sort_order`, date truncation).

- [ ] **Step 1: Write the tests**

Create `src/db/sync.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema } from './schema';
import { frontmatterToRow, reindex } from './sync';
import { NoteRow } from './queries';
import { NoteFrontmatter } from '../vault/types';

describe('frontmatterToRow', () => {
  it('should map hyphenated keys to snake_case columns', () => {
    const fm: NoteFrontmatter = {
      title: 'Test',
      type: 'task',
      status: 'next',
      'sort-order': 20,
      tags: ['api', 'backend'],
      context: ['@computer'],
    };
    const row = frontmatterToRow(fm, '/test.md', 'global', 'hash123');

    expect(row.sort_order).toBe(20);
    expect(row.tags).toBe('["api","backend"]');
    expect(row.context).toBe('["@computer"]');
    expect(row.scope).toBe('global');
  });

  it('should truncate ISO timestamps to date-only strings', () => {
    const fm: NoteFrontmatter = {
      title: 'Test',
      created: '2026-04-01T14:30:00.000Z',
      modified: '2026-04-02T09:00:00.000Z',
      due: '2026-05-01',
    };
    const row = frontmatterToRow(fm, '/test.md', 'global', 'hash');

    expect(row.created).toBe('2026-04-01');
    expect(row.modified).toBe('2026-04-02');
    expect(row.due).toBe('2026-05-01'); // already date-only
  });
});

describe('reindex', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sync-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true });

    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should index all markdown files in a vault directory', async () => {
    fs.writeFileSync(
      path.join(vaultDir, 'inbox', 'task1.md'),
      '---\ntitle: Task One\ntype: task\nstatus: inbox\n---\nBody text.'
    );
    fs.writeFileSync(
      path.join(vaultDir, 'notes', 'note1.md'),
      '---\ntitle: My Note\ntype: note\n---\nNote body.'
    );

    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.inserted).toBe(2);
    expect(stats.deleted).toBe(0);

    const rows = db.all<NoteRow>('SELECT * FROM notes ORDER BY title');
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe('My Note');
    expect(rows[1].title).toBe('Task One');
  });

  it('should skip files that have not changed since last index', async () => {
    const filePath = path.join(vaultDir, 'inbox', 'task1.md');
    fs.writeFileSync(filePath, '---\ntitle: Old\ntype: task\nstatus: inbox\n---\n');

    await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);

    // Reindex without changing the file
    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it('should delete DB rows for files that no longer exist', async () => {
    const filePath = path.join(vaultDir, 'inbox', 'task1.md');
    fs.writeFileSync(filePath, '---\ntitle: Gone\ntype: task\nstatus: inbox\n---\n');

    await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(db.all('SELECT * FROM notes').length).toBe(1);

    // Delete file and reindex
    fs.unlinkSync(filePath);
    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.deleted).toBe(1);
    expect(db.all('SELECT * FROM notes').length).toBe(0);
  });

  it('should handle both global and workspace vaults', async () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'inbox'), { recursive: true });

    fs.writeFileSync(
      path.join(vaultDir, 'inbox', 'global-task.md'),
      '---\ntitle: Global\ntype: task\nstatus: inbox\n---\n'
    );
    fs.writeFileSync(
      path.join(wsDir, 'inbox', 'ws-task.md'),
      '---\ntitle: Workspace\ntype: task\nstatus: next\n---\n'
    );

    await reindex(db, [
      { rootDir: vaultDir, scope: 'global' },
      { rootDir: wsDir, scope: 'workspace' },
    ]);

    const rows = db.all<NoteRow>('SELECT * FROM notes ORDER BY title');
    expect(rows.length).toBe(2);
    expect(rows[0].scope).toBe('global');
    expect(rows[1].scope).toBe('workspace');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/db/sync.test.ts --reporter=verbose
```

Expected: FAIL — `sync.ts` does not exist.

- [ ] **Step 3: Implement `src/db/sync.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GroundworkDB } from './index';
import { upsertNote, deleteNote, NoteRow } from './queries';
import { parseFrontmatter } from '../vault/store';
import { NoteFrontmatter, VaultScope } from '../vault/types';

export interface VaultSource {
  rootDir: string;
  scope: VaultScope;
}

export interface ReindexStats {
  inserted: number;
  skipped: number;
  deleted: number;
}

/** Convert NoteFrontmatter to a NoteRow for DB storage. */
export function frontmatterToRow(
  fm: NoteFrontmatter,
  filePath: string,
  scope: VaultScope,
  bodyHash: string,
): NoteRow {
  return {
    path: filePath,
    scope,
    title: fm.title ?? null,
    type: fm.type ?? null,
    status: fm.status ?? null,
    priority: fm.priority ?? null,
    sort_order: typeof fm['sort-order'] === 'number' ? fm['sort-order'] : null,
    due: truncateDate(fm.due) ?? null,
    project: fm.project ?? null,
    context: fm.context ? JSON.stringify(fm.context) : null,
    tags: fm.tags ? JSON.stringify(fm.tags) : null,
    recurrence: fm.recurrence ?? null,
    created: truncateDate(fm.created) ?? null,
    modified: truncateDate(fm.modified) ?? null,
    body_hash: bodyHash,
    indexed_at: new Date().toISOString(),
  };
}

/** Truncate ISO timestamp to YYYY-MM-DD date string. Passthrough if already date-only. */
function truncateDate(val: string | undefined): string | null {
  if (!val) return null;
  return val.slice(0, 10); // '2026-04-01T14:30:00.000Z' → '2026-04-01'
}

/** Walk vault directories and sync all .md files into the DB. */
export async function reindex(db: GroundworkDB, vaults: VaultSource[]): Promise<ReindexStats> {
  const stats: ReindexStats = { inserted: 0, skipped: 0, deleted: 0 };
  const seenPaths = new Set<string>();

  for (const vault of vaults) {
    const files = await collectMarkdownFiles(vault.rootDir);

    for (const filePath of files) {
      seenPaths.add(filePath);

      // Check mtime against indexed_at
      const fileStat = await fs.promises.stat(filePath);
      const fileMtime = fileStat.mtime.toISOString();

      const existing = db.get<{ indexed_at: string | null }>('SELECT indexed_at FROM notes WHERE path = ?', [filePath]);
      if (existing?.indexed_at && existing.indexed_at >= fileMtime) {
        stats.skipped++;
        continue;
      }

      // Read and parse file
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);

      const row = frontmatterToRow(frontmatter, filePath, vault.scope, bodyHash);
      upsertNote(db, row);
      stats.inserted++;
    }
  }

  // Delete DB rows for files that no longer exist
  const allDbPaths = db.all<{ path: string }>('SELECT path FROM notes');
  for (const { path: dbPath } of allDbPaths) {
    if (!seenPaths.has(dbPath)) {
      deleteNote(db, dbPath);
      stats.deleted++;
    }
  }

  return stats;
}

/** Recursively collect all .md files in a directory, skipping .sessions/. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // Directory doesn't exist
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue; // Skip hidden (.sessions, etc.)

    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/db/sync.test.ts --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 5: Run all tests to verify nothing is broken**

```bash
npx vitest run --reporter=verbose
```

Expected: All tests across the project PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/sync.ts src/db/sync.test.ts
git commit -m "feat: add vault-to-SQLite sync with mtime-based skip and stale row cleanup"
```

---

## Chunk 2: Wire DB into the extension and swap view queries

### Task 7: Wire DB initialization into `extension.ts`

**Files:**
- Modify: `src/extension.ts:25-83` (the `activate()` function)

Add DB open, schema init, and startup reindex to the activation flow. The DB instance is then passed to tree views and briefing panel.

- [ ] **Step 1: Add DB imports and initialization in `activate()`**

At the top of `src/extension.ts`, add the import:

```typescript
import { GroundworkDB } from './db/index';
import { initSchema } from './db/schema';
import { reindex, VaultSource } from './db/sync';
```

After `await manager.init();` (currently line 54), add DB initialization:

```typescript
  // Initialize SQLite index
  const dbPath = path.join(globalPath, '.index.db');
  const db = new GroundworkDB(dbPath);
  await db.open();
  initSchema(db);

  // Startup reindex
  const vaultSources: VaultSource[] = [{ rootDir: globalPath, scope: 'global' }];
  if (manager.workspacePath) {
    vaultSources.push({ rootDir: manager.workspacePath, scope: 'workspace' });
  }
  const reindexStats = await reindex(db, vaultSources);
  db.saveToDisk();
```

- [ ] **Step 2: Add file watcher for runtime sync**

After the reindex block, add a file watcher that syncs external edits:

```typescript
  // File watcher — sync external edits to DB
  const watchPatterns = [
    new vscode.RelativePattern(globalPath, '**/*.md'),
    ...(manager.workspacePath
      ? [new vscode.RelativePattern(manager.workspacePath, '**/*.md')]
      : []),
  ];

  for (const pattern of watchPatterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const syncFile = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (filePath.includes('.sessions')) return; // Skip session logs

      const scope = manager.workspacePath && filePath.startsWith(manager.workspacePath)
        ? 'workspace' as const
        : 'global' as const;

      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const { frontmatter, body } = await import('./vault/store').then(m => m.parseFrontmatter(raw));
        const crypto = await import('crypto');
        const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
        const { frontmatterToRow } = await import('./db/sync');
        const row = frontmatterToRow(frontmatter, filePath, scope, bodyHash);
        const { upsertNote: upsert } = await import('./db/queries');
        upsert(db, row);
        debouncedSave();
      } catch { /* file may have been deleted between events */ }
    };

    watcher.onDidCreate(syncFile);
    watcher.onDidChange(syncFile);
    watcher.onDidDelete(uri => {
      const { deleteNote: del } = require('./db/queries');
      del(db, uri.fsPath);
      debouncedSave();
    });

    ctx.subscriptions.push(watcher);
  }

  // Debounced DB save — flush at most every 500ms
  let saveTimer: NodeJS.Timeout | undefined;
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => db.saveToDisk(), 500);
  };
```

- [ ] **Step 3: Add DB cleanup on deactivation**

In the `deactivate()` function (at the end of `extension.ts`), add:

```typescript
  // Save and close DB
  try {
    db.saveToDisk();
    db.close();
  } catch { /* extension shutting down */ }
```

Note: `db` must be declared at module scope (alongside `manager`, `contextGen`, etc.) for `deactivate()` to access it. Move the declaration to the module-level variables section and assign it in `activate()`.

- [ ] **Step 4: Add .index.db to .gitignore of global vault**

The DB file should not be committed. The spec says it's gitignored. Add it to `~/.groundwork/.gitignore` if not already there — but this is a runtime concern. For the extension, ensure the reindex test above handles it.

- [ ] **Step 5: Compile and verify no TypeScript errors**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: initialize SQLite index on extension activation with file watcher"
```

---

### Task 8: Pass DB to TaskTreeProvider and switch to SQL queries

**Files:**
- Modify: `src/views/task-tree.ts:389-424` (`getChildren()` method)
- Modify: `src/extension.ts` (pass `db` to constructor)

The goal is to replace `this.manager.queryNotes({ type: 'task' })` (which reads every file) with `listTasks(db, filter)` (single SQL query). Filtering and sorting move to SQL.

- [ ] **Step 1: Modify TaskTreeProvider constructor to accept DB**

In `src/views/task-tree.ts`, update the constructor to accept and store a `GroundworkDB` instance:

```typescript
import { GroundworkDB } from '../db/index';
import { listTasks, NoteRow } from '../db/queries';
```

Add `private db: GroundworkDB` parameter to the constructor. The existing `manager` parameter stays — it's still needed for `writeNote()` during DnD.

- [ ] **Step 2: Replace `getChildren()` root-level query**

In `getChildren()` (line 389), replace:

```typescript
let allTasks = await this.manager.queryNotes({ type: 'task' });
allTasks = applyFilters(allTasks, this._filter);
```

With:

```typescript
// Query DB for each status group directly
const statusOrder: TaskStatus[] = ['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled'];

this.cache.clear();
for (const status of statusOrder) {
  const dbFilter: import('../db/queries').TaskFilter = {
    status,
    ...(this._filter.tag ? { tag: this._filter.tag } : {}),
    ...(this._filter.context ? { context: this._filter.context } : {}),
    ...(this._filter.project ? { project: this._filter.project } : {}),
  };
  const rows = listTasks(this.db, dbFilter);

  // Convert NoteRow → ParsedNote for compatibility with existing tree item rendering
  const tasks = await Promise.all(rows.map(row => this.manager.readNote(row.path)));
  const filtered = tasks.filter(Boolean) as ParsedNote[];

  // Apply text search filter (not in SQL — needs body content)
  const searched = this._filter.search
    ? applyFilters(filtered, { search: this._filter.search })
    : filtered;

  if (searched.length > 0) {
    this.cache.set(status, searched);
  }
}
// Sorting is done by SQL — no need for sortTasks() here
```

Note: `manager.readNote()` is still called per-task to get full `ParsedNote` (needed for body in tooltips and text search). This is acceptable because it only reads files for tasks matching the SQL filter — not all vault files. A future optimization can cache bodies in the DB.

- [ ] **Step 3: Update `src/extension.ts` to pass `db` to TaskTreeProvider**

Change the constructor call from:
```typescript
const taskTree = new TaskTreeProvider(manager);
```
to:
```typescript
const taskTree = new TaskTreeProvider(manager, db);
```

- [ ] **Step 4: Compile and verify**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Manually test in VS Code** (F5 launch)

Open the Extension Development Host, verify the task tree still shows all tasks correctly with correct sort order and filter behavior.

- [ ] **Step 6: Commit**

```bash
git add src/views/task-tree.ts src/extension.ts
git commit -m "feat: task tree queries SQLite instead of reading all vault files"
```

---

### Task 9: Switch vault tree metadata to DB lookup

**Files:**
- Modify: `src/views/vault-tree.ts`
- Modify: `src/extension.ts` (pass `db` to VaultTreeProvider)

The vault tree still needs `fs.readdir()` for directory structure, but file metadata (title, type for icons) comes from a single DB query instead of `quickReadMeta()` on each file.

- [ ] **Step 1: Update VaultTreeProvider constructor**

Add `private db: GroundworkDB` parameter. Import:

```typescript
import { GroundworkDB } from '../db/index';
import { allNoteMetadata, NoteRow } from '../db/queries';
```

- [ ] **Step 2: Add metadata cache method**

Add a method that builds a path→metadata map from DB on each refresh:

```typescript
private metadataCache: Map<string, NoteRow> = new Map();

private refreshMetadataCache(): void {
  const rows = allNoteMetadata(this.db);
  this.metadataCache.clear();
  for (const row of rows) {
    this.metadataCache.set(row.path, row);
  }
}
```

Call `this.refreshMetadataCache()` at the start of `getChildren()` when `element` is undefined (root call).

- [ ] **Step 3: Use cache in `listFiles()` processing**

Where the vault tree currently calls `quickReadMeta()` to get title/type for each file, replace with a lookup in `this.metadataCache`:

```typescript
const meta = this.metadataCache.get(absolutePath);
if (meta) {
  file.title = meta.title ?? undefined;
  file.noteType = meta.type ?? undefined;
}
```

This eliminates per-file I/O for metadata.

- [ ] **Step 4: Update `src/extension.ts` constructor call**

```typescript
const vaultTree = new VaultTreeProvider(manager, db);
```

- [ ] **Step 5: Compile and verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/views/vault-tree.ts src/extension.ts
git commit -m "feat: vault tree reads file metadata from SQLite cache"
```

---

### Task 10: Switch briefing panel stats to DB queries

**Files:**
- Modify: `src/views/briefing-panel.ts`
- Modify: `src/extension.ts` (pass `db` to BriefingPanelManager)

The briefing panel's `refresh()` currently reads all tasks via `manager.queryNotes()`. Switch the categorization (overdue, active, next, etc.) to SQL queries.

- [ ] **Step 1: Update BriefingPanelManager constructor**

Add `private db: GroundworkDB` parameter. Import:

```typescript
import { GroundworkDB } from '../db/index';
import { listTasks, taskStats, NoteRow } from '../db/queries';
```

- [ ] **Step 2: Replace task categorization in `refresh()`**

In the `refresh()` method, replace the section that queries all tasks and categorizes them. Use targeted SQL queries:

```typescript
// Overdue: tasks with due date before today, not done/cancelled
const overdue = listTasks(this.db, {}).filter(r =>
  r.due && r.due < todayStr && r.status !== 'done' && r.status !== 'cancelled'
);

// Due soon: due within 3 days
const dueSoon = listTasks(this.db, {}).filter(r =>
  r.due && r.due >= todayStr && r.due <= soonStr && r.status !== 'done' && r.status !== 'cancelled'
);

const active = listTasks(this.db, { status: 'active' });
const next = listTasks(this.db, { status: 'next' });
const inbox = listTasks(this.db, { status: 'inbox' });
const waiting = listTasks(this.db, { status: 'waiting' });
```

Each `NoteRow` needs to be converted to `ParsedNote` for the existing HTML builder. Add a helper that reads the file body only when needed for display:

```typescript
private async rowToNote(row: NoteRow): Promise<ParsedNote> {
  return this.manager.readNote(row.path);
}
```

- [ ] **Step 3: Update `src/extension.ts` constructor call**

```typescript
briefingPanel = new BriefingPanelManager(manager, ctx.extensionUri, refreshAll, db);
```

(Note: check the actual constructor signature — `db` may need to be added as the last parameter.)

- [ ] **Step 4: Compile and verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Test briefing panel** (F5 launch)

Open daily briefing via `Cmd+Shift+G Cmd+Shift+B`. Verify stats match expected values, sections render correctly.

- [ ] **Step 6: Commit**

```bash
git add src/views/briefing-panel.ts src/extension.ts
git commit -m "feat: briefing panel uses SQLite queries for task categorization"
```

---

### Task 11: Add write-through to VaultStore

**Files:**
- Modify: `src/vault/store.ts:102-118` (`writeNote()`)
- Modify: `src/vault/manager.ts`

When the extension writes a file (editor save, DnD status change), the DB should be updated in the same call. This avoids relying solely on the file watcher for internal writes.

- [ ] **Step 1: Add write-through callback to VaultStore**

In `src/vault/store.ts`, add an optional callback that fires after each write:

```typescript
/** Optional callback invoked after every writeNote/delete with the file path */
onWrite?: (filePath: string, frontmatter: NoteFrontmatter, body: string) => void;
onDelete?: (filePath: string) => void;
```

At the end of `writeNote()` (after `fs.writeFileSync`), add:

```typescript
if (this.onWrite) {
  this.onWrite(filePath, frontmatter, body);
}
```

At the end of `delete()`, add:

```typescript
if (this.onDelete) {
  this.onDelete(filePath);
}
```

In `rename()` (line 192), add after `fs.promises.rename(oldPath, newPath)`:

```typescript
if (this.onDelete) this.onDelete(oldPath);
// The watcher will pick up the new file, but for immediate consistency:
if (this.onWrite) {
  const raw = await fs.promises.readFile(newPath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  this.onWrite(newPath, frontmatter, body);
}
```

- [ ] **Step 2: Wire callbacks in VaultManager or extension.ts**

In `src/extension.ts`, after creating the DB and manager, wire up the write-through:

```typescript
import { frontmatterToRow } from './db/sync';
import { upsertNote, deleteNote as dbDeleteNote } from './db/queries';

// Wire write-through on both vault stores
const wireWriteThrough = (store: import('./vault/store').VaultStore) => {
  store.onWrite = (filePath, frontmatter, body) => {
    const bodyHash = require('crypto').createHash('sha256').update(body).digest('hex').slice(0, 16);
    const row = frontmatterToRow(frontmatter, filePath, store.scope, bodyHash);
    upsertNote(db, row);
    debouncedSave();
  };
  store.onDelete = (filePath) => {
    dbDeleteNote(db, filePath);
    debouncedSave();
  };
};

wireWriteThrough(manager.globalStore);
if (manager.workspaceStore) wireWriteThrough(manager.workspaceStore);
```

- [ ] **Step 3: Run all tests**

```bash
npx vitest run --reporter=verbose
```

Expected: All pass. The write-through callbacks are optional and don't affect existing test behavior.

- [ ] **Step 4: Compile and verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Manual integration test**

In Extension Development Host:
1. Create a task via `Cmd+Shift+G Cmd+Shift+T`
2. Verify it appears in the task tree immediately
3. Change its status via right-click → Set Status
4. Verify the tree updates instantly

- [ ] **Step 6: Commit**

```bash
git add src/vault/store.ts src/extension.ts
git commit -m "feat: write-through from VaultStore to SQLite on file writes and deletes"
```

---

### Task 12: Add DB reindex to workspace vault initialization

**Files:**
- Modify: `src/extension.ts`

When the user runs "Init Workspace Vault", the new workspace vault needs to be added to the DB and the file watcher needs to cover it.

- [ ] **Step 1: Update `initWorkspaceVault` helper**

In the `initWorkspaceVault` closure in `extension.ts`, after calling `manager.init()`, add:

```typescript
// Reindex the new workspace vault into DB
if (manager.workspaceStore) {
  await reindex(db, [{ rootDir: manager.workspacePath!, scope: 'workspace' }]);
  db.saveToDisk();
  wireWriteThrough(manager.workspaceStore);
}
```

- [ ] **Step 2: Compile and verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: reindex new workspace vault into SQLite on init"
```

---

### Task 13: Final integration verification and version bump

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Run all tests**

```bash
npx vitest run --reporter=verbose
```

Expected: All pass.

- [ ] **Step 2: Compile clean**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Test destructive cache recovery**

In Extension Development Host:
1. Close VS Code
2. Delete `~/.groundwork/.index.db`
3. Reopen VS Code
4. Verify task tree, vault tree, and briefing panel all work correctly (DB rebuilds on activation)

- [ ] **Step 4: Bump version to 0.4.0**

In `package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0 for SQLite index release"
```
