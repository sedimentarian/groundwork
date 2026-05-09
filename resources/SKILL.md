# Groundwork Vault Integration

Groundwork is a personal task and knowledge management system. The vault is plain
markdown files with YAML frontmatter, organized in a folder structure. You have
full read/write access to the vault — no VS Code extension needed.

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

The body is free-form markdown.
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
| `recurrence` | no | e.g. `daily`, `every monday`, `every 2 weeks`, `monthly` |
| `recurrence-anchor` | no | ISO date anchor for interval calculation |
| `sort-order` | no | Numeric sort key for custom ordering within GTD groups |

### GTD Status Flow

```
inbox → next → active → done
                  ↕        ↑
              waiting ─────┘
inbox → someday → next → ...
any → cancelled
```

## SQLite Index

`~/.groundwork/.index.db` is the query layer. Run the **Ensure DB** script before any
read operation — it initializes the DB if missing and incrementally syncs changed files.

### Ensure DB

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

## Common Operations

### List tasks

1. Run **Ensure DB**
2. Query:

```bash
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT path, title, status, priority, sort_order, due, project, tags, scope
   FROM notes WHERE type='task'
   ORDER BY
     CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC,
     CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
     title COLLATE NOCASE"
```

3. Group by `status`, assign shorthand IDs, label 🌐 (global) or 📂 (workspace).

### Task shorthand references

| Prefix | Status |
|--------|--------|
| `I` | inbox |
| `N` | next |
| `A` | active |
| `W` | waiting |
| `S` | someday |
| `D` | done |
| `C` | cancelled |

Sort order: `sort_order` (NULL last) → priority (high→medium→low) → title alphabetically.

Output format:
```
## Next Actions
N1. Fix login bug [high, due: 2026-03-20] 🌐
N2. Update API docs [medium] 📂
```

Numbers are ephemeral — recalculate each listing. Accept references like "mark N1 done".

### Create a task

Before creating, ask the user: "Would you like to add any details or context to this task? (press Enter to skip)"
- If the user provides context, generate a well-structured markdown body from it and include it as the file body.
- If the user says no, none, or just presses Enter, create with an empty body.
- Exception: if the user said "just capture it", "quick note", or similar, skip the question and create immediately.

1. Slug the title: lowercase, hyphens, no special chars → `fix-login-bug.md`
2. Write to `~/.groundwork/inbox/` (or appropriate directory)
3. Use current ISO timestamp for `created`
4. Run **Ensure DB** to sync into the index

### Update a task

Read the file, update frontmatter, write back with updated `modified` timestamp.
Run **Ensure DB** after to sync the change.

### Daily Briefing

1. Run **Ensure DB**
2. Query:

```bash
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT title, status, priority, due, project, scope FROM notes
   WHERE type='task' AND status IN ('active','next','waiting','inbox','done')
   ORDER BY due ASC NULLS LAST,
     CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
```

Present: Overdue → Active → Next Actions → Waiting For → Inbox count → Recently done (7 days).

### Search and Filter

```bash
# By status/project
sqlite3 -json ~/.groundwork/.index.db "SELECT * FROM notes WHERE type='task' AND status='next'"

# By tag
sqlite3 -json ~/.groundwork/.index.db "SELECT * FROM notes WHERE tags LIKE '%\"bug\"%'"

# Full-text search
sqlite3 -json ~/.groundwork/.index.db \
  "SELECT n.path, n.title, n.status FROM notes n
   JOIN notes_fts f ON n.path = f.path
   WHERE notes_fts MATCH 'login error'"
```

### Delete from DB (after removing a file)

```bash
sqlite3 ~/.groundwork/.index.db \
  "DELETE FROM notes WHERE path='/full/path/to/file.md';
   DELETE FROM notes_fts WHERE path='/full/path/to/file.md';"
```

## Tips

- Run **Ensure DB** before reads — it's fast on a warm DB (skips unchanged files)
- Status is determined by frontmatter, not folder location
- Tags are freeform, keep lowercase and consistent
- The vault is Obsidian-compatible — no non-standard syntax
- When creating multiple tasks at once, write files in parallel then run Ensure DB once
