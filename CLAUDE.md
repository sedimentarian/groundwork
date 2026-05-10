# Groundwork — VS Code Extension

## What This Is

A VS Code extension that provides GTD-style task management and AI context generation through a layered markdown vault. The vault is plain markdown files with YAML frontmatter, stored in `~/.groundwork/` (global) or `.groundwork/` (workspace-local).

## Architecture

```
src/
├── extension.ts          # Entry point, command registration
├── recurrence.ts         # Recurrence pattern parsing
├── vault/
│   ├── types.ts          # NoteFrontmatter, TaskStatus, VaultFile, ParsedNote
│   ├── store.ts          # File CRUD, frontmatter parsing, query by type/status
│   ├── manager.ts        # Multi-vault coordination (global + workspace)
│   └── staleness.ts      # Mtime comparison for stale task detection
├── context/
│   └── generator.ts      # Context compilation (markdown/XML), CLAUDE.md generation
├── session/
│   └── tracker.ts        # Activity logging as JSONL
└── views/
    ├── task-tree.ts       # Sidebar: tasks grouped by GTD status
    ├── vault-tree.ts      # Sidebar: file browser
    ├── session-tree.ts    # Sidebar: recent activity feed
    ├── editor-panel.ts    # WYSIWYG editor webview (uses marked + turndown)
    └── briefing-panel.ts  # Daily briefing webview (AI summary via vscode.lm API)
```

## Key Patterns

### Frontmatter-Driven
All metadata lives in YAML frontmatter. The file's location in the directory tree is secondary — `status`, `type`, `priority` etc. are in frontmatter. See `src/vault/types.ts` for the full `NoteFrontmatter` interface.

### Dual Vault Scopes
Global vault (`~/.groundwork/`) and workspace vault (`.groundwork/` in project root) coexist. The `VaultManager` merges both for display. The scope dropdown in the editor lets users choose where to save.

### Webview Panels
The editor and briefing views use VS Code webview panels with inline HTML/CSS/JS. They communicate with the extension via `postMessage` / `onDidReceiveMessage`. CSP is enforced.

### AI Integration
- **Daily briefing summary**: Uses `vscode.lm.selectChatModels()` for AI-generated summaries with template fallback
- **Context compilation**: Compiles selected vault content into prompt-ready blocks for AI tools
- **CLAUDE.md / copilot-instructions generation**: Exports active context as global instruction files (`~/.claude/CLAUDE.md`, `~/.groundwork/copilot-instructions.md`)

### Custom sql.js Build
Both `sql-wasm.js` and `sql-wasm.wasm` are vendored in `lib/` (custom build with FTS5 enabled). The extension loads from `lib/` at runtime, not from `node_modules`. Both files must come from the same build. See `build/README-custom-sqljs.md` for rebuild instructions.

## Development

```bash
# Compile
npx tsc

# Run in VS Code
# Press F5 (uses .vscode/launch.json → Extension Development Host)

# Package
npx vsce package

# Install locally
code --install-extension groundwork-*.vsix
```

## Task Status Values

`inbox` | `next` | `active` | `waiting` | `someday` | `done` | `cancelled`

## Current State

- Compiles clean
- No test suite yet (priority target: `src/recurrence.ts` pure functions)
- Not yet published to marketplace (publisher: `sedimentarian`)
- Active backlog in `~/.groundwork/inbox/` — use the groundwork skill to view

## Conventions

- TypeScript strict mode
- No external image/canvas dependencies (PNG icon generated from raw bytes)
- UMD bundles for webview libs (marked, turndown) loaded via webview URI
- Webview HTML is constructed as template strings in TypeScript (no framework)
