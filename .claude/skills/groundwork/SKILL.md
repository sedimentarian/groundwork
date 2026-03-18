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
markdown files with YAML frontmatter, organized in a folder structure. You have
full read/write access to the vault — no VS Code extension needed.

## Vault Locations

- **Global vault**: `~/.groundwork/` — available everywhere
- **Workspace vault**: `.groundwork/` in the current project root — project-specific

Always check both locations. The global vault is the primary one. Workspace vaults
are optional and project-scoped.

## Directory Structure

```
.groundwork/
├── inbox/        # New captures, untriaged tasks
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
| `type` | yes | `task`, `note`, `project`, `reference`, `log` |
| `status` | for tasks | `inbox`, `next`, `active`, `waiting`, `someday`, `done`, `cancelled` |
| `priority` | no | `high`, `medium`, `low` |
| `project` | no | Parent project name |
| `tags` | no | YAML list of strings |
| `created` | yes | ISO 8601 timestamp |
| `modified` | no | ISO 8601 timestamp (update on changes) |
| `due` | no | ISO date |
| `context` | no | GTD contexts like `@computer`, `@phone` |

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

## Common Operations

### List tasks

Read all `.md` files from the vault directories. Parse frontmatter to filter
by status, priority, project, or tags.

```bash
# Quick view of all tasks — use Glob + Read tools instead of bash when possible
```

Prefer using the **Glob** tool to find files and **Read** tool to parse them.
Group results by status when presenting to the user.

### Create a task

1. Generate a filename slug from the title: lowercase, replace spaces with hyphens,
   remove special characters. Example: "Fix login bug" → `fix-login-bug.md`
2. Write to `~/.groundwork/inbox/` (default) or the appropriate status directory
3. Use the current ISO timestamp for `created`

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
the `modified` timestamp. If changing status, consider whether the file should
move to a different directory (the extension manages this, but for CLI use the
file can stay in its current directory — status is determined by frontmatter,
not folder location).

### Capture a quick idea

When the user says something like "remind me to..." or "I should...", create an
inbox task immediately. Keep the bar low — capturing fast matters more than
perfect formatting.

### Daily Briefing (`/brief`)

Compile a summary of the user's current state. Read all task files and present:

1. **Overdue** — tasks with `due` date before today
2. **Active** — tasks with `status: active`
3. **Next Actions** — tasks with `status: next` (the ready-to-work queue)
4. **Waiting For** — tasks with `status: waiting` (blocked items)
5. **Inbox count** — how many untriaged items
6. **Recently completed** — tasks marked `done` in the last 7 days

Format it as a clean, scannable summary. Keep it brief — this is a dashboard
glance, not a deep report.

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

1. Gather active/next tasks
2. Include relevant project notes
3. Include any reference docs the user specifies
4. Format as a structured block (markdown or XML)

### Search and Filter

The vault supports several filtering dimensions when querying tasks:

- **By tag**: Filter on the `tags` frontmatter array (e.g., `feature`, `bug`, `ux`)
- **By context**: Filter on the `context` frontmatter array (e.g., `@computer`, `@phone`)
- **By project**: Filter on the `project` frontmatter field
- **Full-text search**: Search across title, body, tags, and project fields (case-insensitive substring match)

Multiple filters can be combined simultaneously.

For CLI/tool use: use the **Grep** tool to search across vault files for keywords,
then **Read** the matching files to present results with context. For structured
filtering, parse frontmatter from all task files and filter in memory.

## Session Tracking

The `.sessions/` directory contains daily JSONL files (one JSON object per line):

```jsonl
{"action":"create","file":"inbox/fix-login-bug.md","timestamp":"2026-03-17T14:30:00.000Z"}
{"action":"status_change","file":"inbox/fix-login-bug.md","detail":"inbox → active","timestamp":"2026-03-17T15:00:00.000Z"}
```

You don't need to write session entries — the VS Code extension handles that.
But you can read them to understand recent activity.

## Tips

- When listing tasks, always group by status and sort by priority within groups
- Use `high`/`medium`/`low` priority — don't invent new levels
- Tags are freeform but keep them lowercase and consistent
- The vault is designed to work with Obsidian too — don't add non-standard syntax
- If the user asks "what should I work on?", look at `next` and `active` tasks,
  prioritize by `priority` and `due` date
- When creating multiple tasks at once, write them all in parallel for speed
