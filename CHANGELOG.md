# Changelog

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
- Renamed from "KB Vault" to "Groundwork"
- All command prefixes changed from `kbvault.*` to `groundwork.*`
- Data directory changed from `.kbvault` to `.groundwork`
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
