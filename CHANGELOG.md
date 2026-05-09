# Changelog

## 0.5.1 — 2026-05-09

### Changed
- **Context-aware note/task creation** — `create_task` and `create_note` MCP tools now instruct AI agents to ask for additional context before creating a file. If context is provided, the agent generates a structured markdown body from it; if the user declines or presses Enter, the file is created with no body. Quick-capture phrases ("just capture it", "quick note") bypass the prompt. A `bodyWasEmpty` hint in the tool response gives agents a second opportunity to offer expansion after creation.
- **Skill files updated** — same context-prompting behavior added to `resources/SKILL.md`, `resources/claude-skill.md`, and `.claude/skills/groundwork/SKILL.md` so create behavior is consistent whether using MCP or the fallback skill

## 0.5.0 — 2026-05-08

### Added
- **MCP server** — 11 vault tools (list, get, create, update, delete tasks/notes; search; compile context; get briefing) exposed over stdio via `@modelcontextprotocol/sdk`. Registered as a VS Code MCP server — Claude Code and Copilot discover and call it automatically without any manual configuration
- **Shorthand resolution in MCP** — task references like N1, A2, S3 resolve to vault file paths via the SQLite index, matching the sidebar sort order
- **SQLite index** — `~/.groundwork/.index.db` mirrors all vault frontmatter and body text. Synced live via write-through hooks and a file watcher; bootstrapped from the skill when VS Code is not running. Enables fast queries, FTS4 full-text search, and stable shorthand numbering
- **SQLite-backed context generation** — `Generate CLAUDE.md` and `Generate Copilot Instructions` now query the SQLite index via a `notes_fts` JOIN instead of reading every vault file, with fallback to file reads when the DB is unavailable
- **Updated agent skills** — `resources/SKILL.md` (Copilot) and `.claude/skills/groundwork/SKILL.md` (Claude Code) rewritten to use SQLite-first querying with an inline Python bootstrap script (`Ensure DB`) that initialises and incrementally syncs the DB when VS Code is not running

### Fixed
- **WYSIWYG hyperlink button** — replaced broken `prompt()` + `document.execCommand('createLink')` (both blocked in VS Code webviews) with an inline link popover using DOM Selection/Range API
- **Link editing** — click any existing link in the editor to open the popover pre-filled with the current URL; ✕ button unwraps the link
- **Auto-linking** — URLs typed followed by a space/Enter are automatically wrapped in anchor tags; pasting a bare URL creates a link or wraps selected text
- **`path` import in shorthand.ts** — moved from inline `require('path')` to a top-level import

### Changed
- Minimum VS Code version bumped to 1.99.0 (required for `McpStdioServerDefinition` MCP contribution point)
- `resources/SKILL.md` is now the canonical Copilot skill source; manual install `curl` URL updated accordingly
- `.vscodeignore` broadened `sql.js` exception from individual files to `!node_modules/sql.js/**`
- **Cmd+K** shortcut added to WYSIWYG editor for inserting/editing links (context-aware: pre-fills when cursor is inside an existing link)

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
- **AI agent skill** — bundles a skill file (`resources/SKILL.md`) installed globally by the Generate commands
- **Webview accessibility** — aria labels, keyboard navigation, semantic HTML in editor and briefing panels
- **Global context generation** — `Generate CLAUDE.md` writes to `~/.claude/CLAUDE.md`; `Generate Copilot Instructions` writes to `~/.groundwork/copilot-instructions.md` with auto-configuration of VS Code setting
- **Optimized skill task listing** — skill recommends single `grep` command for vault listing instead of per-file reads

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
