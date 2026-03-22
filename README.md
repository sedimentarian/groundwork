```
   ______                          __                    __
  / ____/________  __  ______  ___/ /      ______  _____/ /__
 / / __/ ___/ __ \/ / / / __ \/ __  / | /| / / __ \/ ___/ //_/
/ /_/ / /  / /_/ / /_/ / / / / /_/ /| |/ |/ / /_/ / /  / ,<
\____/_/   \____/\__,_/_/ /_/\__,_/ |__/|__/\____/_/  /_/|_|
```

**Your tasks, your context, your grounding.**

Groundwork is a VSCode extension that builds structured, persistent context — notes, reference knowledge, projects, and tasks that can be directly fed into Copilot, Claude Code, and any AI tool you use. Think of it as layers: raw knowledge at the bottom, structured notes above, actionable tasks at the top, all connected and ready to surface when your AI needs it.

---

## The Problem

AI coding tools are powerful but stateless. They need a global and local reference to ensure there's context and a todo list of activities to Get Things Done. Maintaining the relationship with global and local context requires you to copy files, re-explain your projects or guiding principles, and generates scraps of information in various places. Developing global or local (workspace) context allows you to bypass grounding your work each time and allows you to layer from global to local between conversations, between tools, between days.

**Groundwork lays the foundation beneath your AI workflow:**

```
┌─────────────────────────────────────────┐
│  AI Tools (Copilot, Claude, ChatGPT)    │  ← consume context
├─────────────────────────────────────────┤
│  Tasks & Actions                        │  ← what you're doing now
│  (inbox → next → active → done)         │
├─────────────────────────────────────────┤
│  Projects & Notes                       │  ← what you've decided
│  (architecture, decisions, thinking)    │
├─────────────────────────────────────────┤
│  Reference Knowledge                    │  ← what you know
│  (guides, patterns, conventions)        │
├─────────────────────────────────────────┤
│  Session History                        │  ← what you've done
│  (opens, saves, status changes, logs)   │
└─────────────────────────────────────────┘
```

One click compiles any combination of these layers into context your AI can use. Generate `CLAUDE.md` or `copilot-instructions.md` directly from your vault. Start every session grounded in what actually matters.

---

## Features

| Feature | Description |
|---|---|
| **Layered vault** | Reference knowledge, notes, projects, and tasks — all markdown, all portable |
| **Daily Briefing** | AI-summarized overview of your day with task counts, overdue alerts, and focus recommendations |
| **Task management** | GTD-style flow: Inbox → Next → Active → Waiting → Someday → Done |
| **Recurring tasks** | Daily, weekday, weekly, monthly, quarterly — auto-clones on completion |
| **WYSIWYG editor** | Rich markdown editing with frontmatter form, toolbar, and type-based file routing |
| **Dual vault** | Global vault (all workspaces) + workspace vault (per project) |
| **One-click context** | Compile active tasks and notes into clipboard-ready AI context |
| **AI file generation** | Auto-generate `~/.claude/CLAUDE.md` and `~/.groundwork/copilot-instructions.md` from vault |
| **Staleness detection** | Warns when AI instruction files are older than your vault |
| **Session tracking** | Logs activity so you always know where you left off |

---

## Getting Started

### Requirements

- VSCode 1.89.0 or later

### Installation

Install from the VSCode Extension Marketplace or load from source:

```bash
git clone https://github.com/sedimentarian/groundwork.git
cd groundwork
npm install
npm run compile
# Press F5 in VSCode to launch the Extension Development Host
```

### First Steps

1. **Click the Groundwork icon** in the Activity Bar (the strata icon on the sidebar)
2. Three panels appear: **Tasks**, **Vault**, and **Recent Activity**
3. Click **+** in the Tasks panel header to create your first task
4. The global vault is created automatically at `~/.groundwork` on first use

> **Tip:** The global vault (`~/.groundwork`) is always active. For project-specific notes, use the **Init Workspace Vault** button in the Vault panel header — this creates a `.groundwork/` folder in your current workspace.

---

## Skills

Groundwork ships with an **agent skill** that teaches AI tools how to interact with your vault directly — creating tasks, running briefings, triaging inbox, and more — all from the CLI without needing the VS Code extension UI.

The canonical skill lives at `.claude/skills/groundwork/SKILL.md` in this repo. The **Generate** commands install it globally for each tool.

### Auto-installation via Generate commands

| Command | Writes to | Skill file |
|---|---|---|
| **Generate CLAUDE.md** | `~/.claude/CLAUDE.md` | `~/.claude/skills/groundwork/SKILL.md` |
| **Generate Copilot Instructions** | `~/.groundwork/copilot-instructions.md` | `~/.groundwork/copilot-skill.md` |

Claude Code auto-discovers skills in `~/.claude/skills/`. For Copilot, the Generate command offers to add the instructions file to your VS Code user settings automatically.

### Manual installation

If you prefer to install the skill manually:

**Claude Code** — install globally (works in every project):
```bash
mkdir -p ~/.claude/skills/groundwork
curl -o ~/.claude/skills/groundwork/SKILL.md \
  https://raw.githubusercontent.com/sedimentarian/groundwork/main/.claude/skills/groundwork/SKILL.md
```

**GitHub Copilot** — add to VS Code user settings (`settings.json`):
```json
{
  "github.copilot.chat.codeGeneration.instructions": [
    { "file": "~/.groundwork/copilot-instructions.md" }
  ]
}
```

### What the skill enables

- Read and write vault files (frontmatter + markdown body)
- Create, update, and triage tasks using GTD status flow
- Reference tasks by shorthand (N1, I2, S3) matching the sidebar sort order
- Run daily briefings and weekly reviews
- Search and filter by tag, context, project, or text
- Compile context for other AI tools
- Capture quick ideas directly to inbox
- Archive and delete with proper guards

### Generated instruction files

Use `Groundwork: Generate CLAUDE.md` or `Groundwork: Generate Copilot Instructions` from the Command Palette to create global instruction files that reference the skill. These files tell your AI tools about the vault and direct them to use the skill for task management — no per-project setup needed.

> **Tip:** The skill provides *read-write capability* to interact with the vault. Generated files provide *read-only context* about your current work. Use both together for the best experience.

---

## Daily Briefing

The Daily Briefing is an at-a-glance dashboard for your day. Open it from:

- **Calendar button** in the Tasks panel header
- **Command Palette**: `Groundwork: Daily Briefing`
- **Status bar**: click the task count in the bottom bar
- **Auto-open**: enable `groundwork.dailyBriefing.autoOpen` to show it once per day on startup

### What it shows

- **AI summary** — a 2-3 sentence overview of what to focus on today (uses VS Code Language Model API when available, falls back to a smart template)
- **Stats bar** — overdue, active, open, done today, recurring counts
- **Task sections** — Overdue, Due Soon, Active, Next Actions, Inbox, Waiting, Recently Completed
- **Recurrence processing** — automatically clones due recurring tasks to inbox on refresh
- **Clickable tasks** — click any task title to open it in the WYSIWYG editor

### Status bar

The status bar shows a live summary: `2 overdue · 3 active · 1 inbox`. It turns amber when you have overdue tasks. Click it to open the briefing.

---

## The Vault

All content is markdown files with YAML frontmatter. No database, no lock-in. Edit in any text editor, commit to git, open in Obsidian.

### Structure

```
~/.groundwork/                  <- global vault (always active)
  inbox/                        <- captured tasks, not yet processed (Tasks panel only)
  decisions/                    <- architecture decisions, trade-offs, ADRs
  notes/                        <- thinking, scratch, working notes
  projects/                     <- project-level context
  reference/                    <- durable knowledge and guides
  logs/                         <- structured log entries
  .sessions/                    <- session activity (JSONL)

your-project/.groundwork/       <- workspace vault (per project)
  inbox/
  decisions/
  notes/
  projects/
  reference/
```

### Type Routing

When you create or change a note's type, Groundwork moves it to the right folder automatically:

| Type | Folder | Purpose |
|---|---|---|
| **Task** | `inbox/` | Something to do (shown in Tasks panel only) |
| **Decision** | `decisions/` | Architecture decisions, trade-offs, ADRs |
| **Note** | `notes/` | Thinking, scratch, working notes |
| **Project** | `projects/` | Project-level context |
| **Reference** | `reference/` | Durable knowledge |

### Global vs Workspace

- **Global** (`~/.groundwork`): Always present. Cross-project tasks, personal knowledge, reference material.
- **Workspace** (`.groundwork/` in your project): Active only in that workspace. Project-specific tasks, decisions, context.

When creating content, you choose where it lives. If no workspace vault exists yet, choosing "Workspace" creates one automatically.

### Moving Between Scopes

**From the task list**: Right-click > **Move to Workspace** or **Move to Global**.

**From the editor**: Change the **Scope** dropdown. The file moves and the editor reopens from the new location.

---

## Task Management

Tasks use a GTD-inspired flow to move work from capture through completion:

| Status | Meaning |
|---|---|
| **Inbox** | Captured but not yet processed |
| **Next Actions** | Ready to do — your prioritized queue |
| **Active** | In progress right now |
| **Waiting For** | Blocked on someone or something |
| **Someday / Maybe** | Not committed, keep for later |
| **Done** | Completed |
| **Cancelled** | No longer relevant |

### Visual Indicators

Each task shows a **color dot** for urgency:

| Color | Meaning |
|---|---|
| Red | Overdue or high priority |
| Amber | Due within 3 days |
| Default | Medium priority, no due pressure |
| Blue | Low priority |
| Green | Done |
| Gray | Cancelled |

A **scope badge** shows whether it's in the global or workspace vault. Hover for a full tooltip.

### Marking Tasks Done

- **Checkbox click**: Instant done. Click again on a done task to reopen it.
- **Right-click > Mark Done**: Context menu.
- **Editor**: Change the Status dropdown directly.

### Recurring Tasks

Add a `recurrence` field to make tasks repeat. When marked **done**, the Daily Briefing clones a fresh copy to **inbox** on the next occurrence.

| Pattern | Meaning |
|---|---|
| `daily` | Every day |
| `weekday` | Monday through Friday |
| `every Monday` | Weekly on a specific day |
| `every 2 weeks` | Any interval |
| `monthly` | Once per month |
| `1st of month` | Specific day |
| `quarterly` | Every 3 months |

---

## WYSIWYG Editor

Opening any vault file shows a rich editor — not raw markdown.

### Frontmatter Card

| Field | Description |
|---|---|
| Title | Display name |
| Type | Note, Task, Reference, or Project — changing this moves the file |
| Scope | Global or Workspace — changing this moves the file between vaults |
| Status | GTD status (task only) — saves immediately |
| Priority | High, Medium, Low (task only) |
| Due Date | Date picker (task only) |
| Context | GTD contexts like `@computer` (task only) |
| Project | Parent project name |
| Tags | Freeform tags |

### Toolbar

Bold, Italic, Strikethrough, H1/H2/H3, Bullet list, Numbered list, Task checklist, Blockquote, Inline code, Link, Horizontal rule.

**Shortcuts**: `Cmd+S` save, `Cmd+B` bold, `Cmd+I` italic.

---

## AI Context Integration

This is what it's all for — making your layers of knowledge and work immediately available to AI tools.

### Quick Context

**Lightning bolt** in the Tasks panel header. Compiles everything **Active** and **Next Actions**, groups by project, copies to clipboard. Paste into any AI tool.

```markdown
# Current Work Context
_Generated 2026-03-15T14:30_

## My Project
- **[active]** Implement authentication (@computer)
  > Using JWT tokens, need to add refresh token rotation

- **[next]** Write API documentation
```

**Use this at the start of every AI session.**

### Compile Context

**Export icon** in the Tasks panel header. Multi-select from all vault content, choose Markdown or XML format. Opens in a tab with one-click copy.

### Generate CLAUDE.md

`Groundwork: Generate CLAUDE.md` — generates a `CLAUDE.md` from active tasks and reference notes. Claude Code reads this automatically.

### Generate Copilot Instructions

`Groundwork: Generate Copilot Instructions` — generates `.github/copilot-instructions.md`. Copilot reads this automatically.

### Staleness Detection

On workspace open, Groundwork checks if your AI files are older than your vault. If so, it suggests regenerating.

---

## Session Tracking

The **Recent Activity** panel shows a timeline of the last 50 events:

| Icon | Event |
|---|---|
| Eye | File opened |
| Disk | File saved |
| Page | File created |
| Arrows | Status changed |
| Box | Context compiled |
| Pencil | Activity note logged |

**Log Activity** captures quick notes about decisions, discoveries, or completed work.

---

## Commands

All available via Command Palette (`Cmd+Shift+P`) prefixed with `Groundwork:`.

| Command | Description |
|---|---|
| Daily Briefing | AI-powered daily overview |
| Weekly Review | Full-week overview panel with stats, categorized sections, and inline status actions |
| New Task | Create a task |
| New Note | Create a note (blank, template, or AI-generated) |
| New Note Here | Create a note in a specific vault folder (right-click) |
| Open in WYSIWYG Editor | Open a vault file in the rich editor |
| Copy Active Context to Clipboard | One-click context for AI |
| Compile Context for AI | Manual multi-select context compilation |
| Generate CLAUDE.md | Generate from vault |
| Generate Copilot Instructions | Generate from vault |
| Set Task Status | Change GTD status |
| Mark Done | Complete a task |
| Move to Global Vault | Move from workspace to global |
| Move to Workspace Vault | Move from global to workspace |
| Initialize Workspace Vault | Create `.groundwork/` in workspace |
| Open Vault Folder | Change global vault location |
| Filter by Tag | Filter tasks by tag |
| Search Tasks | Full-text search across task titles, bodies, tags, and projects |
| Clear Task Filters | Remove active task filters |
| Filter Vault | Filter vault by type or tag |
| Search Vault | Full-text search across vault notes |
| Clear Vault Filter | Remove active vault filters |
| Collapse All Tasks | Collapse all task groups |
| Expand All Tasks | Expand all task groups |
| Collapse All Vault | Collapse all vault folders |
| Expand All Vault | Expand all vault folders |
| Log Activity | Add a timestamped note |
| Refresh | Reload sidebar |
| Rename | Rename a note or task (updates title and filename). Right-click or F2 |
| Archive | Move a vault file to `archive/` (safety net before deletion) |
| Unarchive | Move an archived file back to `notes/` |
| Delete | Permanently delete an archived vault file or a done/cancelled task |

---

## Configuration

Settings under **Groundwork** in VSCode Settings.

| Setting | Default | Description |
|---|---|---|
| `groundwork.globalPath` | `~/.groundwork` | Global vault directory |
| `groundwork.newTaskDefaultScope` | `workspace` | Default scope for new tasks |
| `groundwork.newNoteDefaultScope` | `global` | Default scope for new notes |
| `groundwork.gtd.contexts` | `[@computer, ...]` | GTD context options |
| `groundwork.context.maxTokenEstimate` | `4000` | Token limit for context compilation |
| `groundwork.autoDetectStaleness` | `true` | Check for stale AI files on startup |
| `groundwork.dailyBriefing.autoOpen` | `false` | Auto-open briefing once per day |

---

## File Format

Standard markdown with YAML frontmatter. Fully portable.

**Task** (`inbox/my-task.md`):

```markdown
---
title: Implement refresh token rotation
type: task
status: active
priority: high
due: 2026-03-20
recurrence: every 2 weeks
recurrence-anchor: 2026-03-06
context:
  - "@computer"
project: Auth System
tags:
  - security
  - backend
created: 2026-03-15T10:30:00.000Z
modified: 2026-03-15T14:22:00.000Z
---

Using JWT tokens with 15-minute access tokens and 7-day refresh tokens.

## Notes

Need to add rotation logic so a refresh token is invalidated after use.
```

**Reference note** (`reference/architecture-decisions.md`):

```markdown
---
title: Architecture Decisions
type: reference
tags:
  - architecture
created: 2026-03-01T09:00:00.000Z
---

## 2026-03-10 — Chose Redis for session storage
Rationale: distributed session state for horizontal scaling.
Alternative considered: PostgreSQL — rejected due to latency.
```

---

## Privacy

Groundwork stores all data locally on your machine. It does not collect telemetry, track usage, or send data to external servers. The optional AI summary feature uses VS Code's built-in Language Model API — data handling is governed by your VS Code/Copilot configuration, not by Groundwork.

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

---

## Tips

**Start every AI session grounded.** Hit the lightning bolt before opening Claude or Copilot. Your work context is on the clipboard in under a second.

**Check the briefing each morning.** It processes recurring tasks, flags what's overdue, and tells you where to focus.

**Build your layers.** Reference knowledge at the bottom, project notes in the middle, tasks on top. The richer your vault, the better your AI context.

**Scope intentionally.** Project-specific work goes in the workspace vault. Cross-cutting knowledge goes global.

**Write your thinking.** The note body isn't just storage — write decisions, blockers, and rationale. That feeds directly into AI context, giving your tools the *why* not just the *what*.
