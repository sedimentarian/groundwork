# Groundwork: MCP Server + SQLite Index

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Architecture change — adds SQLite index and MCP server to the Groundwork VS Code extension

---

## Problem

The Groundwork extension has two scaling bottlenecks:

1. **AI tool experience:** The skill file teaches AI tools to interact with the vault via grep + manual frontmatter parsing. This is ~300 lines of bash conventions, fragile, and produces unstructured text that tools must re-parse. Every AI session re-learns the same file format.

2. **Extension performance:** Tree views, briefing panel, and context generation re-read every markdown file on every refresh. Each refresh walks the vault directories, opens each `.md` file, parses YAML frontmatter, and builds in-memory structures. This scales linearly with vault size.

Both problems share a root cause: there is no queryable index. Every consumer re-derives metadata from raw files on every access.

## Solution

Add two layers:

- **SQLite index** — a persistent cache of all vault metadata, queryable with SQL. Source of truth for metadata reads. Markdown files remain the authoring format.
- **MCP server** — hosted inside the VS Code extension process, exposes structured tools that AI tools call directly. No more grep, no more frontmatter parsing instructions.

## Architecture

```
AI Tools (Claude Code, Copilot)
    │
    │  MCP protocol (stdio/SSE)
    │
    ▼
MCP Server (src/mcp/)
    │
    │  typed tool calls
    │
    ▼
SQLite Index (src/db/)          ◄── FileSystemWatcher (external edits)
    │
    │  write-through
    │
    ▼
Markdown Files (~/.groundwork/, .groundwork/)
```

The extension's own views also query SQLite instead of reading files:

```
Tree Views / Briefing Panel
    │
    │  db.listTasks(), db.stats(), etc.
    │
    ▼
SQLite Index
```

---

## Section 1: SQLite Schema & Sync

### Database location

`~/.groundwork/.index.db` — gitignored, treated as a disposable cache. Deleting it triggers a full reindex on next activation.

A workspace vault (`<workspace>/.groundwork/`) does not get its own DB. Both vaults are indexed into the single global DB, distinguished by the `scope` column. When the user switches workspaces, stale workspace entries (files that no longer exist on disk) are cleaned up during the startup reindex — step 4 checks all DB rows regardless of scope.

### Schema

```sql
CREATE TABLE notes (
  path        TEXT PRIMARY KEY,   -- absolute path to .md file
  scope       TEXT NOT NULL,      -- 'global' | 'workspace'
  title       TEXT,
  type        TEXT,               -- task | note | decision | project | reference | log
  status      TEXT,               -- inbox | next | active | waiting | someday | done | cancelled
  priority    TEXT,               -- high | medium | low
  sort_order  INTEGER,
  due         TEXT,               -- YYYY-MM-DD date string (date only, no time)
  project     TEXT,
  context     TEXT,               -- JSON array of @-tags, e.g. ["@computer","@home"]
  tags        TEXT,               -- JSON array, e.g. ["api","backend"]
  recurrence  TEXT,               -- daily | weekday | weekly | monthly | quarterly
  created     TEXT,               -- YYYY-MM-DD date string
  modified    TEXT,               -- YYYY-MM-DD date string
  body_hash   TEXT,               -- SHA-256 of body content, for change detection
  indexed_at  TEXT,               -- ISO timestamp of last sync
  schema_version INTEGER DEFAULT 1
);

CREATE INDEX idx_type_status ON notes(type, status);
CREATE INDEX idx_due ON notes(due);
CREATE INDEX idx_project ON notes(project);
CREATE INDEX idx_scope ON notes(scope);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');

-- Full-text search across title and body (content-synced with triggers)
CREATE VIRTUAL TABLE notes_fts USING fts5(
  path,
  title,
  body,
  content='notes',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync with notes table
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, path, title, body)
    VALUES (new.rowid, new.path, new.title, '');
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, path, title, body)
    VALUES ('delete', old.rowid, old.path, old.title, '');
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, path, title, body)
    VALUES ('delete', old.rowid, old.path, old.title, '');
  INSERT INTO notes_fts(rowid, path, title, body)
    VALUES (new.rowid, new.path, new.title, '');
END;
```

**Frontmatter key mapping:** YAML frontmatter uses hyphenated keys (e.g. `sort-order`, `recurrence-anchor`). The sync layer maps these to SQL column names: `sort-order` → `sort_order`. This mapping is defined once in `sync.ts` and used for all read/write operations.

**Date format convention:** All date columns (`due`, `created`, `modified`) store `YYYY-MM-DD` date strings to match SQLite's `date()` function. The sync layer truncates ISO timestamps from frontmatter (e.g. `2026-03-22T14:30:00.000Z` → `2026-03-22`) on index. The original full timestamp is preserved in the markdown file — the DB only needs date precision for comparisons.

**Schema migration strategy:** The `meta` table stores the current schema version. On activation, the DB layer checks `meta.schema_version` against the expected version in code. If they differ, the DB is dropped and rebuilt from vault files. This is simple and safe because the DB is a disposable cache — no data is lost on rebuild.

### Sync strategy

**Startup reindex:**
1. Walk both vault directories, collect all `.md` file paths and mtimes
2. For each file: compare `file mtime` against `indexed_at` in DB
3. If newer or missing: read file, parse frontmatter, upsert row + FTS
4. Delete DB rows whose files no longer exist on disk
5. Full reindex if DB file is missing (~200 files in <1s)

**Runtime file watcher:**
- `vscode.workspace.createFileSystemWatcher('**/*.md')` scoped to both vault paths
- `onDidCreate` → read file, insert DB row + FTS
- `onDidChange` → read file, compare `body_hash`, upsert if changed
- `onDidDelete` → delete DB row + FTS entry

**Write-through:**
- When the extension writes a file (editor save, DnD status change, MCP tool call), it updates the DB in the same function call — no watcher delay
- The watcher still runs as a safety net for external edits (user edits a file in vim, Obsidian, etc.)

### Module choice

`sql.js` — SQLite compiled to WASM via Emscripten. Pure JavaScript, zero native dependencies, no platform-specific compilation. Adds ~1.2MB to the extension package (the WASM binary). Loads once at extension activation.

This avoids all `better-sqlite3` packaging issues (node-gyp, platform binaries, Electron version mismatches).

### Persistence

`sql.js` operates on an in-memory ArrayBuffer. The DB must be explicitly saved to disk:
- Save after every write-through operation (debounced, 500ms)
- Save on extension deactivation
- Save after startup reindex completes
- Load from disk on activation, or create fresh if missing

---

## Section 2: MCP Server & Tool Definitions

### Transport

The extension registers an MCP server using VS Code's MCP contribution point. Claude Code and Copilot discover it automatically when the extension is active — no manual `mcpServers` config needed.

Fallback: if VS Code's MCP API isn't available (older versions), the extension can expose an SSE endpoint on localhost that Claude Code connects to via `.claude.json` config.

### Tools

11 tools covering the full vault lifecycle:

#### list_tasks

```typescript
{
  name: "list_tasks",
  description: "List tasks from the Groundwork vault, filtered and sorted",
  parameters: {
    status: "string?",     // inbox | next | active | waiting | someday | done | cancelled
    priority: "string?",   // high | medium | low
    project: "string?",    // project name
    context: "string?",    // @-tag
    tag: "string?",        // tag name
    scope: "string?",      // global | workspace
    limit: "number?"       // default 50
  },
  returns: "Array<{ path, shorthand, title, status, priority, due, sort_order, project, scope }>"
}
```

SQL: `SELECT ... FROM notes WHERE type='task' AND status=? ORDER BY sort_order, priority, title`

#### get_note

```typescript
{
  name: "get_note",
  description: "Get full content of a note or task by path or shorthand",
  parameters: {
    ref: "string"  // absolute path, relative path, or shorthand (N1, A2, etc.)
  },
  returns: "{ path, frontmatter: {...}, body: string }"
}
```

Reads frontmatter from DB, body from file. Shorthand resolved via DB query.

#### create_task

```typescript
{
  name: "create_task",
  description: "Create a new task in the vault",
  parameters: {
    title: "string",
    status: "string?",     // default: inbox
    priority: "string?",   // default: medium
    due: "string?",        // ISO date
    project: "string?",
    tags: "string[]?",
    context: "string[]?",
    body: "string?",
    scope: "string?"       // default: from settings
  },
  returns: "{ path, shorthand }"
}
```

Writes `.md` file to appropriate directory, inserts DB row, fires tree refresh.

#### create_note

```typescript
{
  name: "create_note",
  description: "Create a new note, decision, project, or reference document",
  parameters: {
    title: "string",
    type: "string",        // note | decision | project | reference | log
    body: "string?",
    project: "string?",
    tags: "string[]?",
    scope: "string?"
  },
  returns: "{ path }"
}
```

#### update_note

```typescript
{
  name: "update_note",
  description: "Update fields on an existing note or task",
  parameters: {
    ref: "string",         // path or shorthand
    fields: {
      title: "string?",
      status: "string?",
      priority: "string?",
      due: "string?",
      project: "string?",
      tags: "string[]?",
      context: "string[]?",
      body: "string?",
      sort_order: "number?"
    }
  },
  returns: "{ path, updated_fields: string[] }"
}
```

Reads current file, merges fields, writes file + updates DB. If status changes, moves file to the appropriate status directory (e.g. `inbox/` → `next/`). Does **not** change scope or note type — use `move_note` for that.

#### move_note

```typescript
{
  name: "move_note",
  description: "Move a note between scopes or change its type",
  parameters: {
    ref: "string",
    target_scope: "string?",  // global | workspace
    target_type: "string?"    // changes directory: note → notes/, decision → decisions/, etc.
  },
  returns: "{ old_path, new_path }"
}
```

#### search

```typescript
{
  name: "search",
  description: "Full-text search across vault titles and body content",
  parameters: {
    query: "string",
    type: "string?",
    status: "string?",
    scope: "string?",
    limit: "number?"      // default 20
  },
  returns: "Array<{ path, title, type, snippet }>"
}
```

Uses FTS5: `SELECT ... FROM notes_fts WHERE notes_fts MATCH ?`

#### daily_briefing

```typescript
{
  name: "daily_briefing",
  description: "Get a structured daily briefing of current work",
  parameters: {},
  returns: {
    overdue: "Task[]",
    due_soon: "Task[]",     // due within 3 days
    active: "Task[]",
    next: "Task[]",
    inbox_count: "number",
    waiting: "Task[]",
    recently_completed: "Task[]",  // last 7 days
    stats: { overdue, active, open, done_today, recurring }
  }
}
```

All data from DB aggregation queries — no file reads.

#### weekly_review

```typescript
{
  name: "weekly_review",
  description: "Get structured data for a GTD weekly review",
  parameters: {},
  returns: {
    stale_waiting: "Task[]",     // waiting > 7 days
    old_inbox: "Task[]",         // inbox > 3 days
    someday_candidates: "Task[]",
    completed_this_week: "Task[]",
    projects_without_next: "string[]"
  }
}
```

#### archive_note

```typescript
{
  name: "archive_note",
  description: "Move a note to the archive directory",
  parameters: {
    ref: "string"   // path or shorthand
  },
  returns: "{ archived_path }"
}
```

#### delete_note

```typescript
{
  name: "delete_note",
  description: "Permanently delete a note (only archived or cancelled items)",
  parameters: {
    ref: "string"   // path or shorthand
  },
  returns: "{ deleted_path }"
}
```

Guard: only allows deletion of files in `archive/` or tasks with status `cancelled`. Returns `VALIDATION_ERROR` otherwise. Matches the existing `groundwork.deleteNote` command behavior.

### Shorthand resolution

Shorthands (N1, A2, S3) are resolved by querying the DB with the same sort order the tree view uses:

```sql
SELECT path, ROW_NUMBER() OVER (ORDER BY sort_order, priority, title) as idx
FROM notes
WHERE type = 'task' AND status = ?
```

Prefix letter maps to status: I=inbox, N=next, A=active, W=waiting, S=someday, D=done, C=cancelled.

This guarantees shorthands always match the sidebar numbering.

**Shorthand stability caveat:** Shorthands are computed dynamically from current DB state. If a task is created or deleted between an AI tool's `list_tasks` call and a subsequent `update_note` call, the shorthand may resolve to a different task. MCP tool responses include both `shorthand` and `path` — AI tools should prefer `path` for update/delete operations. Shorthands are best for human-readable display and interactive selection within a single tool call.

### Error contract

All MCP tools return structured errors when operations fail:

```typescript
{ error: string, code: "NOT_FOUND" | "INVALID_REF" | "WRITE_FAILED" | "VALIDATION_ERROR" }
```

Expected error conditions:
- `get_note` / `update_note` / `archive_note`: `NOT_FOUND` when ref doesn't resolve to a file
- `update_note`: `VALIDATION_ERROR` when status value is invalid
- `create_task` / `create_note`: `WRITE_FAILED` when file cannot be written (permissions, disk full)
- Any tool with `ref` param: `INVALID_REF` when shorthand format is unrecognized

### Event propagation

```
MCP tool call (e.g. update_note status → 'done')
  → VaultStore.writeNote() — writes .md file, moves to done/ if needed
  → DB upsert — same call, no delay
  → onDidChangeNotes.fire()
  → TaskTree.refresh() — queries DB, rebuilds tree
  → Sidebar updates in real time
```

AI tools see their changes reflected in the VS Code UI immediately.

---

## Section 3: Extension View Integration

### Current flow (filesystem)

```
TreeView.refresh()
  → VaultManager.listFiles()     -- readdir + read every .md file
  → parseFrontmatter() per file  -- YAML parsing
  → filter/sort in JS memory
  → build TreeItem[]
```

### New flow (SQLite)

```
TreeView.refresh()
  → db.listTasks(filters)       -- single SQL query
  → build TreeItem[]
```

### Task Tree changes

`getChildren()` for a status group becomes:

```typescript
const tasks = db.query(
  `SELECT * FROM notes WHERE type='task' AND status=? ORDER BY sort_order, priority, title`,
  [status]
);
```

Filtering by tag, project, context, or search text becomes additional WHERE clauses or FTS joins. The current in-memory filter-and-sort logic in `task-tree.ts` (~100 lines) is replaced by parameterized queries.

DnD status change: calls `VaultStore.writeNote()` which does file write + DB update, then fires `onDidChangeNotes` which triggers `refresh()`.

### Vault Tree changes

The directory structure still comes from `fs.readdir()` — it's a folder view and must reflect the actual filesystem. But file metadata (title, type for icon selection) comes from a single DB query instead of reading each file:

```typescript
const metadata = db.queryMap(
  `SELECT path, title, type FROM notes WHERE scope=?`,
  [scope]
);
// Then for each readdir entry, look up metadata[absolutePath]
```

### Briefing Panel changes

All stats become SQL aggregations:

```sql
-- Overdue
SELECT * FROM notes WHERE type='task' AND due < date('now') AND status NOT IN ('done','cancelled');

-- Stats bar
SELECT status, COUNT(*) as count FROM notes WHERE type='task' GROUP BY status;

-- Recently completed
SELECT * FROM notes WHERE type='task' AND status='done' AND modified > date('now', '-7 days');
```

The AI summary still uses `vscode.lm` API — it just receives structured data from DB instead of parsed file content.

### Editor Panel

No change. The editor reads and writes the full markdown file directly. On save, the write-through path updates the DB. The editor doesn't need DB access.

### Session Tracker

No change. Stays as append-only JSONL in `.sessions/`. Not worth indexing — it's a write-heavy log with simple date-based access.

### Context Generator

`compileActiveContext()` and `generateClaudeMd()` switch from reading files to DB queries for metadata. Body content is still read from files when needed (e.g., "include first paragraph of each active task"). The generated files reference MCP tools instead of grep instructions.

---

## Section 4: Package Structure & Dependencies

### New source layout

```
src/
├── db/
│   ├── index.ts           -- DB lifecycle: init, open, close, save to disk
│   ├── schema.ts          -- CREATE TABLE/INDEX statements, version migrations
│   ├── queries.ts         -- typed query functions: listTasks, getNote, stats, search, etc.
│   └── sync.ts            -- startup reindex, file watcher → DB sync, write-through helper
├── mcp/
│   ├── server.ts          -- MCP server setup, transport, tool registration
│   ├── tools.ts           -- tool handler implementations (11 tools)
│   └── shorthand.ts       -- N1/A2/S3 resolution from DB
├── vault/
│   ├── store.ts           -- writeNote() gains write-through to DB
│   ├── manager.ts         -- query methods delegate to DB; file ops unchanged
│   └── types.ts           -- unchanged
├── context/
│   └── generator.ts       -- queries DB for metadata, reads files for body
├── views/
│   ├── task-tree.ts       -- getChildren() queries DB
│   ├── vault-tree.ts      -- metadata from DB, structure from readdir
│   ├── editor-panel.ts    -- unchanged
│   ├── briefing-panel.ts  -- stats from DB aggregations
│   └── session-tree.ts    -- unchanged
├── session/
│   └── tracker.ts         -- unchanged
└── extension.ts           -- adds DB init + MCP server startup to activate()
```

### Dependencies

| Package | Purpose | Bundle size impact |
|---|---|---|
| `sql.js` | SQLite via WASM | +1.2MB (wasm binary) |
| `@modelcontextprotocol/sdk` | MCP server protocol | ~50KB |

Total `.vsix` grows from ~120KB to ~1.4MB. Still small for a VS Code extension.

### Build

No build changes needed. `sql.js` is pure JS + WASM. The WASM binary needs to be included in the `vsix` via the `files` field in `package.json` or a bundler copy step.

`tsconfig.json` may need adjustment if MCP SDK types require different module resolution.

### What gets deleted (Phase 3)

- `SKILL.md` grep/parse/format instructions (~250 lines)
- `store.ts` `listFiles()` full-file-read loop and in-memory frontmatter parsing for queries
- `task-tree.ts` and `vault-tree.ts` in-memory filtering/sorting logic (~100 lines each)
- `context/generator.ts` grep-based skill instructions in generated files

---

## Section 5: Migration & Rollout

### Phase 1 — SQLite layer (v0.4.0)

**Scope:** Add `src/db/`, wire file watcher + write-through, swap tree views and briefing to query DB.

**Prerequisites:**
- Add `recurrence` as a typed field on `NoteFrontmatter` in `types.ts` (currently survives via `[key: string]: unknown` index signature)
- Add `recurrence-anchor` similarly

**What ships:**
- SQLite index at `~/.groundwork/.index.db`
- Startup reindex + file watcher sync
- Task tree, vault tree, briefing panel all query DB
- Write-through on editor save, DnD, status change

**What doesn't change:**
- Skill file (still grep-based)
- Context generator output
- Editor panel
- MCP (not yet added)

**User impact:** Faster tree refreshes and briefing loads. No vault format changes. No new dependencies to configure.

**Testable independently:** Yes — the DB is an invisible optimization. If it breaks, delete `.index.db` and it rebuilds.

### Phase 2 — MCP server (v0.5.0)

**Scope:** Add `src/mcp/`, register 10 tools, write new slim SKILL.md.

**What ships:**
- MCP server hosted in extension process
- 11 structured tools (list_tasks, create_task, update_note, search, etc.)
- New SKILL.md (~40 lines) referencing MCP tools
- Context generator produces MCP-aware instructions

**What doesn't change:**
- DB layer (proven in Phase 1)
- Editor panel, session tracker
- Vault file format

**User impact:** AI tools interact via structured calls instead of grep. Dramatically simpler and more reliable. Old grep-based skill still works as fallback.

### Phase 3 — Cleanup (v0.6.0)

**Scope:** Remove dead code, finalize migration.

**What ships:**
- Remove old `listFiles()` full-read code path
- Remove grep-based skill instructions
- Remove `copilot-instructions.md` generation if Copilot discovers MCP natively
- Clean up any remaining filesystem-direct query paths

**User impact:** Smaller extension, cleaner codebase. No behavioral changes.

### Backward compatibility

- Markdown files are never modified by this change — vault format is identical
- Old SKILL.md grep approach continues to work against the unchanged files
- DB is a gitignored cache — safe to delete, rebuilds automatically
- No user configuration required — DB and MCP server are internal to the extension

---

## Testing Strategy

The existing test infrastructure uses `vitest` (see `store.test.ts`, `recurrence.test.ts`).

**Phase 1 (DB layer):**
- Unit tests for `queries.ts`: in-memory `sql.js` DB, insert rows, verify query results for each function
- Unit tests for `sync.ts`: write temp markdown files, run reindex, verify DB state matches files
- Integration tests: write file via `VaultStore.writeNote()`, verify DB row updated (write-through)
- Regression: verify tree view output matches pre-DB behavior for a fixture vault

**Phase 2 (MCP server):**
- Unit tests for each MCP tool handler: mock DB, verify correct SQL and response shape
- Integration tests: call MCP tool → verify file written + DB updated + tree refreshed
- Shorthand resolution tests: verify N1/A2 maps to correct task with various sort orders

**All phases:**
- Destructive cache test: delete `.index.db`, verify full rebuild produces identical state
- External edit test: modify file outside VS Code, verify watcher syncs DB within 1s

---

## VS Code Version Requirements

The MCP contribution point API requires VS Code 1.99+. Phase 2 should bump `engines.vscode` from `^1.89.0` to `^1.99.0`. Phase 1 (DB only) has no new VS Code API requirements and can keep the current minimum.

If users are on older VS Code versions, the SSE fallback (localhost endpoint + `.claude.json` config) provides MCP access without the native contribution point.

---

## Existing Code Integration Notes

**`weekly-review.ts`:** The existing weekly review implementation at `src/weekly-review.ts` will be reused. The `weekly_review` MCP tool delegates to the same logic, with DB queries replacing file reads for gathering review data.

**`recurrence.ts`:** The recurrence system at `src/recurrence.ts` is unaffected — it operates on parsed notes and writes via `VaultStore`. The DB picks up recurrence-cloned tasks via write-through.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `sql.js` WASM loading fails on some platforms | Low | Fallback to filesystem queries; DB is optional cache |
| DB gets out of sync with files | Medium | File watcher + write-through + startup reindex; user can delete `.index.db` |
| VS Code MCP API changes (still evolving) | Medium | Phase 2 is independent of Phase 1; can adapt transport layer |
| Extension activation slows due to DB init | Low | Reindex is async; tree views show loading state until ready |
| `.vsix` size increase (120KB → 1.4MB) | Low | Still well within normal range for VS Code extensions |

---

## Success Criteria

1. **Task listing via MCP:** AI tool calls `list_tasks` and gets structured JSON in <100ms
2. **Tree refresh time:** <50ms for 200-item vault (vs current ~500ms+ with file reads)
3. **Skill file size:** <50 lines (vs current 303)
4. **Zero data loss:** Markdown files are never the secondary copy — they remain the authoring format
5. **Transparent upgrade:** Existing users notice faster performance, nothing else changes
