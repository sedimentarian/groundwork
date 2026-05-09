---
name: groundwork
description: >
  Interact with the Groundwork task and knowledge vault — a GTD-style system stored
  as markdown files with YAML frontmatter. Use this skill whenever the user mentions
  tasks, todos, backlog, inbox, daily briefing, capturing ideas, triaging work,
  checking what's next, reviewing progress, or anything related to their Groundwork
  vault. Also trigger when the user says "groundwork", "/brief", "/tasks", "/capture",
  or asks about what they're working on, what's overdue, or what to do next.
---

# Groundwork Vault Integration

Groundwork is a personal task and knowledge management system. The vault is plain
markdown files with YAML frontmatter, organized in a folder structure.

## Integration path

**Check for the MCP server first.** If `mcp__Groundwork_Vault__list_tasks` is
available, use MCP tools — they are faster, structured, and always in sync.

Available MCP tools: `list_tasks`, `get_task`, `create_task`, `update_task`,
`delete_task`, `search_vault`, `get_note`, `create_note`, `update_note`,
`compile_context`, `get_briefing`.

**Fall back to this skill** when MCP tools are unavailable (VS Code not running).
The skill bootstraps the SQLite index and provides equivalent read/write access.

## Vault Locations

- **Global vault**: `~/.groundwork/` — available everywhere
- **Workspace vault**: `.groundwork/` in the current project root — project-specific

Both vaults are indexed in a single SQLite DB at `~/.groundwork/.index.db`. Queries
automatically cover both; use the `scope` column (`global` / `workspace`) to label results.

## Directory Structure

```
.groundwork/
├── inbox/        # New captures, untriaged tasks
├── decisions/    # Architecture decisions, trade-offs, ADRs
├── notes/        # General notes
├── projects/     # Project-level docs
├── reference/    # Reference material
├── logs/         # Activity logs
└── .sessions/    # Session tracking (JSONL, one file per day)
```

Tasks live as individual `.md` files. The filename is a slug of the title
(lowercase, hyphens, no special chars). Example: `write-test-suite.md`

## File Format

Every markdown file has YAML frontmatter between `---` fences:

```markdown
---
title: Write test suite
type: task
status: inbox
priority: medium
project: Groundwork
tags:
  - testing
  - quality
created: 2026-03-17T12:00:00.000Z
---

The body is free-form markdown. Use headings, lists, code blocks — whatever
helps describe the task or note.
```

### Frontmatter Fields

| Field | Required | Values |
|-------|----------|--------|
| `title` | yes | Human-readable title |
| `type` | yes | `task`, `note`, `decision`, `project`, `reference`, `log` |
| `status` | for tasks | `inbox`, `next`, `active`, `waiting`, `someday`, `done`, `cancelled` |
| `priority` | no | `high`, `medium`, `low` |
| `project` | no | Parent project name |
| `tags` | no | YAML list of strings |
| `created` | yes | ISO 8601 timestamp |
| `modified` | no | ISO 8601 timestamp (update on changes) |
| `due` | no | ISO date |
| `context` | no | GTD contexts like `@computer`, `@phone` |
| `recurrence` | no | Recurrence pattern (e.g., `daily`, `every monday`, `every 2 weeks`, `monthly`, `quarterly`) |
| `recurrence-anchor` | no | ISO date — anchor point for interval calculation |
| `sort-order` | no | Numeric sort key for custom ordering within GTD groups |

### GTD Status Flow

```
inbox → next → active → done
                  ↕        ↑
              waiting ─────┘
inbox → someday → next → ...
any → cancelled
```

- **inbox**: Captured but not yet triaged
- **next**: Triaged and ready to work on
- **active**: Currently being worked on
- **waiting**: Blocked on something external
- **someday**: Interesting but not now
- **done**: Completed
- **cancelled**: Won't do

## SQLite Index

`~/.groundwork/.index.db` is the query layer. It mirrors all vault frontmatter and
supports full-text search via FTS4. The VS Code extension keeps it live (write-through
+ file watcher). When VS Code is not running, use the **Ensure DB** script below to
initialize or sync it before querying.

### Ensure DB

Run this **before any read operation**. It creates the DB if missing, applies the
schema, and incrementally indexes any new or changed vault files (unchanged files are
skipped via body hash comparison, so this is fast on a warm DB).

```bash
python3 << 'PYEOF'
import sqlite3, os, re, json, hashlib
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = os.path.expanduser('~/.groundwork/.index.db')
SCHEMA_VERSION = 1

def parse_frontmatter(text):
    if not text.startswith('---'):
        return {}, text
    end = text.find('\n---', 3)
    if end == -1:
        return {}, text
    fm_text = text[4:end]
    body = text[end+4:].lstrip('\n')
    fm = {}
    current_key = None
    current_list = None
    for line in fm_text.split('\n'):
        if line.startswith('  - ') and current_list is not None:
            current_list.append(line[4:].strip())
            continue
        if current_list is not None:
            fm[current_key] = current_list
            current_list = None
        if ': ' in line:
            key, _, val = line.partition(': ')
            key = key.strip(); val = val.strip()
            if not val:
                current_key = key; current_list = []
            else:
                fm[key] = val
        elif line.rstrip().endswith(':') and line[:1].isalpha():
            current_key = line.rstrip().rstrip(':')
            current_list = []
    if current_list is not None:
        fm[current_key] = current_list
    return fm, body

def init_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS notes (
            path TEXT PRIMARY KEY, scope TEXT NOT NULL,
            title TEXT, type TEXT, status TEXT, priority TEXT,
            sort_order INTEGER, due TEXT, project TEXT,
            context TEXT, tags TEXT, recurrence TEXT,
            created TEXT, modified TEXT, body_hash TEXT,
            indexed_at TEXT, schema_version INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_type_status ON notes(type, status);
        CREATE INDEX IF NOT EXISTS idx_due ON notes(due);
        CREATE INDEX IF NOT EXISTS idx_project ON notes(project);
        CREATE INDEX IF NOT EXISTS idx_scope ON notes(scope);
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts4(path, title, body);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT OR REPLACE INTO meta VALUES ('schema_version', '1');
    """)
    conn.commit()

def schema_ok(conn):
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        return row and int(row[0]) == SCHEMA_VERSION
    except:
        return False

def upsert_file(conn, md_file, scope):
    try:
        text = Path(md_file).read_text(encoding='utf-8', errors='replace')
    except:
        return
    fm, body = parse_frontmatter(text)
    body_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
    existing = conn.execute("SELECT body_hash FROM notes WHERE path=?", (str(md_file),)).fetchone()
    if existing and existing[0] == body_hash:
        return
    tags = fm.get('tags'); context = fm.get('context'); so = fm.get('sort-order')
    conn.execute("""
        INSERT OR REPLACE INTO notes
        (path, scope, title, type, status, priority, sort_order, due, project,
         context, tags, recurrence, created, modified, body_hash, indexed_at, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    """, (
        str(md_file), scope,
        fm.get('title'), fm.get('type'), fm.get('status'), fm.get('priority'),
        int(so) if so and str(so).isdigit() else None,
        (fm.get('due') or '')[:10] or None,
        fm.get('project'),
        json.dumps(context) if isinstance(context, list) else (context or None),
        json.dumps(tags) if isinstance(tags, list) else (tags or None),
        fm.get('recurrence'),
        (fm.get('created') or '')[:10] or None,
        (fm.get('modified') or '')[:10] or None,
        body_hash, datetime.now(timezone.utc).isoformat()
    ))
    conn.execute("DELETE FROM notes_fts WHERE path=?", (str(md_file),))
    conn.execute("INSERT INTO notes_fts (path, title, body) VALUES (?,?,?)",
                 (str(md_file), fm.get('title') or '', body))

def index_vault(conn, vault_dir, scope):
    vault_path = Path(vault_dir)
    if not vault_path.exists():
        return
    for md_file in vault_path.rglob('*.md'):
        parts = md_file.relative_to(vault_path).parts
        if any(p.startswith('.') for p in parts):
            continue
        upsert_file(conn, md_file, scope)
    conn.commit()

os.makedirs(os.path.expanduser('~/.groundwork'), exist_ok=True)
conn = sqlite3.connect(DB_PATH)
if not schema_ok(conn):
    init_schema(conn)
index_vault(conn, os.path.expanduser('~/.groundwork'), 'global')
index_vault(conn, os.path.join(os.getcwd(), '.groundwork'), 'workspace')
conn.close()
print('DB ready')
PYEOF
```

### Sync a file to the DB after writing

After creating or updating any vault file, re-run **Ensure DB** — it detects the
changed body hash and upserts just that file. No separate sync step needed.

## Common Operations

### List tasks

1. Run **Ensure DB**
2. Query all tasks:

```bash
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT path, title, status, priority, sort_order, due, project, tags, scope
   FROM notes WHERE type='task'
   ORDER BY
     CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC,
     CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
     title COLLATE NOCASE"
```

3. Group the JSON results by `status`, assign shorthand IDs, and display.
   Label each task with 🌐 (scope=global) or 📂 (scope=workspace).

### Task shorthand references

When listing tasks, **always** assign shorthand IDs using a status prefix + number:

| Prefix | Status |
|--------|--------|
| `I` | inbox |
| `N` | next |
| `A` | active |
| `W` | waiting |
| `S` | someday |
| `D` | done |
| `C` | cancelled |

**Sort order within each group** (must match the sidebar tree view):
1. `sort_order` (ascending; NULL = last)
2. `priority` (high → medium → low)
3. `title` alphabetically

**Output format:**
```
## Next Actions
N1. Fix login bug [high, due: 2026-03-20] 🌐
N2. Quick reference shorthand [medium] 🌐
N3. Update API docs [medium] 📂
```

**Usage rules:**
- Always output shorthand numbers when listing tasks
- Accept user references like "mark N1 done", "what's I3?", "move S2 to next"
- Numbers are ephemeral — recalculate on each listing, don't persist them
- When a user references a shorthand, resolve it against the most recent listing in the conversation
- **Numbers are always based on the full unfiltered list** — if the user has a filter active, numbers may skip (e.g., N1, N3, N7) but N3 always refers to the same task regardless of filters

### Create a task

Before creating, ask the user: "Would you like to add any details or context to this task? (press Enter to skip)"
- If the user provides context, generate a well-structured markdown body from it and include it as the file body.
- If the user says no, none, or just presses Enter, create with an empty body.
- Exception: if the user said "just capture it", "quick note", or similar, skip the question and create immediately.

1. Generate a filename slug from the title: lowercase, replace spaces with hyphens,
   remove special characters. Example: "Fix login bug" → `fix-login-bug.md`
2. Write to `~/.groundwork/inbox/` (default) or the appropriate status directory
3. Use the current ISO timestamp for `created`
4. Run **Ensure DB** to sync the new file into the index

**Example — creating a task:**
```markdown
---
title: Fix login bug
type: task
status: inbox
priority: high
project: MyApp
tags:
  - bug
  - auth
created: 2026-03-17T14:30:00.000Z
---

The login form throws a 500 error when the email contains a plus sign.
Likely an encoding issue in the auth middleware.
```

### Update a task

Read the file, modify the frontmatter field(s), write it back. Always update
the `modified` timestamp. Then run **Ensure DB** to sync the change into the index.

If changing status, consider whether the file should move to a different directory
(the extension manages this automatically, but for CLI use the file can stay in its
current directory — status is determined by frontmatter, not folder location).

### Rename a task or note

To rename, update both the frontmatter `title` and the filename:

1. Read the file and update `title` in frontmatter
2. Update `modified` timestamp
3. Derive the new filename slug: lowercase, replace non-alphanum with hyphens, trim, append `.md`
4. If the slug changed, write the updated content to the new filename (same directory) and delete the old file
5. If the slug is the same (e.g., just a casing change), overwrite in place
6. Run **Ensure DB** to sync

### Capture a quick idea

When the user says something like "remind me to..." or "I should...", create an
inbox task immediately. Keep the bar low — capturing fast matters more than
perfect formatting.

### Daily Briefing

1. Run **Ensure DB**
2. Query:

```bash
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT title, status, priority, due, project, scope, path FROM notes
   WHERE type='task' AND status IN ('active','next','waiting','inbox','done')
   ORDER BY due ASC NULLS LAST, CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
```

3. Present as a clean, scannable summary:
   1. **Overdue** — `due < today` and status not done/cancelled
   2. **Active** — `status = 'active'`
   3. **Next Actions** — `status = 'next'`
   4. **Waiting For** — `status = 'waiting'`
   5. **Inbox count** — count of `status = 'inbox'`
   6. **Recently completed** — `status = 'done'` and `modified >= today - 7 days`

### Weekly Review

Walk the user through a guided GTD weekly review. Go through each phase in order:

1. **Waiting For** — anything unblocked? Move to Next/Active
2. **Active** — still working on these? Complete or pause?
3. **Someday / Maybe** — promote, kill, or keep?
4. **Inbox** — triage each untriaged item
5. **Recently Completed** — celebrate, identify follow-ups
6. **Capture** — anything new to add?

For each task in phases 1-4, present the task and ask what to do with it.
Log a session entry when the review completes.

### Context Compilation

When the user needs to share context with another AI tool or document what
they're working on, compile relevant vault content:

1. Query active/next tasks from the DB
2. Read the body of relevant task and project files
3. Format as a structured block (markdown or XML)

### Search and Filter

Use SQL for structured queries, FTS4 for full-text search.

```bash
# By status
sqlite3 -json ~/.groundwork/.index.db "SELECT * FROM notes WHERE type='task' AND status='next'"

# By project
sqlite3 -json ~/.groundwork/.index.db "SELECT * FROM notes WHERE project='MyApp'"

# By tag (tags stored as JSON array string)
sqlite3 -json ~/.groundwork/.index.db "SELECT * FROM notes WHERE tags LIKE '%\"bug\"%'"

# Full-text search across title and body
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT n.path, n.title, n.status FROM notes n
   JOIN notes_fts f ON n.path = f.path
   WHERE notes_fts MATCH 'login error'
   ORDER BY n.status"
```

Multiple filters can be combined with AND/OR in the WHERE clause.

## Session Tracking

The `.sessions/` directory contains daily JSONL files (one JSON object per line):

```jsonl
{"action":"create","file":"inbox/fix-login-bug.md","timestamp":"2026-03-17T14:30:00.000Z"}
{"action":"status_change","file":"inbox/fix-login-bug.md","detail":"inbox → active","timestamp":"2026-03-17T15:00:00.000Z"}
```

You don't need to write session entries — the VS Code extension handles that.
But you can read them to understand recent activity.

## Archive and Delete

### Vault files (notes, references, projects)
- **Archive**: Move the file to `archive/` in the same vault. Do not delete vault
  files directly — archive first.
- **Unarchive**: Move the file from `archive/` back to `notes/`.
- **Delete**: Only delete vault files that are already in `archive/`.
- Archived files are excluded from search, filter, and context compilation.

### Tasks
- Tasks do not use archive. They follow the GTD status flow.
- **Delete**: Only delete tasks with status `done` or `cancelled`.
  To remove an unwanted task, set its status to `cancelled` first, then delete.
- After deleting a file, remove it from the DB:
  ```bash
  sqlite3 ~/.groundwork/.index.db \
    "DELETE FROM notes WHERE path='/full/path/to/file.md';
     DELETE FROM notes_fts WHERE path='/full/path/to/file.md';"
  ```

## Tips

- Always run **Ensure DB** before read operations — it's idempotent and fast on a warm DB
- When listing tasks, always group by status and sort by priority within groups
- Use `high`/`medium`/`low` priority — don't invent new levels
- Tags are freeform but keep them lowercase and consistent
- The vault is designed to work with Obsidian too — don't add non-standard syntax
- If the user asks "what should I work on?", look at `next` and `active` tasks,
  prioritize by `priority` and `due` date
- When creating multiple tasks at once, write them all in parallel for speed, then run Ensure DB once
