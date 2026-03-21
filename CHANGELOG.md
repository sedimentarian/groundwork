# Changelog

## 0.3.0 — 2026-03-21

### Added
- **Weekly Review** — full-week overview panel with stats, categorized task sections, and inline status actions
- **Drag-and-drop tasks** — drag tasks between GTD status groups to change status; drag within a group to reorder
- **Drag-and-drop vault files** — drag files between vault folders; type updates automatically to match target folder
- **Filtering** — filter tasks by tag, context, project, or full-text search; filter vault by type, tag, or search
- **Inline rename** — rename notes and tasks via right-click or F2 (updates title and filename)
- **Archive/unarchive** — move vault files to `archive/` as a safety net before deletion
- **Delete guards** — only archived vault files or done/cancelled tasks can be deleted
- **Collapse/expand all** — collapse or expand all task groups and vault folders
- **.gitignore prompt** — prompts to add `.groundwork/` to `.gitignore` when initializing a workspace vault in a git repo
- **AI agent skill** — ships a skill file at `.claude/skills/groundwork/SKILL.md` for Claude Code and Copilot auto-discovery
- **Webview accessibility** — aria labels, keyboard navigation, semantic HTML in editor and briefing panels

### Fixed
- Task drag-and-drop now correctly persists status changes (payload marshalling, sort-order race, editor panel stale state)
- Vault drag-and-drop updates frontmatter type to match target folder
- Editor panel reopens at new path after file moves

### Changed
- Task tree uses robust `extractDraggedPaths()` helper for cross-platform DataTransfer handling
- Vault `writeNote()` enforces canonical type from destination folder as a safety net

## 0.2.0 — 2026-03-17

### Added
- **Daily Briefing** — AI-summarized dashboard with task overview, stats bar, and focus recommendations
- **Recurring tasks** — daily, weekday, weekly, monthly, quarterly patterns with automatic clone-on-completion
- **AI summary** — uses VS Code Language Model API when available, falls back to smart template
- **Status bar** — live task counts with overdue warning, click to open briefing
- **Auto-open briefing** — configurable once-per-day auto-open on startup
- **Note type routing** — changing a note's type automatically moves it to the correct folder
- **Notes folder** — dedicated `notes/` directory in vault structure
- **Note creation methods** — blank, template, or AI-generated notes

### Changed
- Scope dropdown now always interactive when a workspace folder is open (creates vault on demand)

## 0.1.0 — 2026-03-15

### Added
- Initial release
- GTD task management with inbox, next, active, waiting, someday, done, cancelled
- Dual vault system (global + workspace)
- WYSIWYG markdown editor with frontmatter card
- AI context compilation (quick copy and manual select)
- CLAUDE.md and copilot-instructions.md generation
- Staleness detection for AI instruction files
- Session tracking with activity logging
- Checkbox-based task completion
- Visual indicators (priority dots, scope badges, due date warnings)
