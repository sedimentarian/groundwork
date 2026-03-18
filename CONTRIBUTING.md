# Contributing to Groundwork

## Dev Setup

```bash
git clone https://github.com/lwbailey/groundwork
cd groundwork
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

### Useful Commands

| Command | Description |
|---|---|
| `npm run compile` | Build TypeScript to `out/` |
| `npm run watch` | Rebuild on file changes |
| `npm run lint` | Run ESLint |
| `npx vsce package --no-dependencies` | Build `.vsix` for local install |
| `code --install-extension groundwork-*.vsix --force` | Install locally |

## Code Structure

```
src/
├── extension.ts              # Entry point — command registration, tree views, file watchers
├── note-creation.ts          # Note creation flow (blank, template, AI-generated)
├── recurrence.ts             # Recurring task logic (clone on completion)
│
├── vault/
│   ├── types.ts              # Core types: NoteFrontmatter, TaskStatus, ParsedNote, VaultFile
│   ├── store.ts              # File CRUD — read/write/delete markdown with frontmatter
│   ├── manager.ts            # Orchestrates global + workspace stores, query interface
│   └── staleness.ts          # Detects stale CLAUDE.md / copilot-instructions.md
│
├── context/
│   └── generator.ts          # Compile vault content into AI-ready context blocks
│
├── session/
│   └── tracker.ts            # Activity logging (.sessions/*.jsonl)
│
└── views/
    ├── task-tree.ts           # Tasks sidebar — GTD groups, filters, drag-and-drop, sorting
    ├── vault-tree.ts          # Vault browser sidebar — file tree with scope roots
    ├── session-tree.ts        # Recent Activity sidebar — session event timeline
    ├── editor-panel.ts        # WYSIWYG editor webview — frontmatter form + rich text
    └── briefing-panel.ts      # Daily Briefing webview — AI summary + task dashboard
```

### Key Patterns

- **Frontmatter is truth.** Task status, type, priority — all stored in YAML frontmatter. The folder a file lives in is secondary; frontmatter fields drive behavior.
- **Two vaults.** Global (`~/.groundwork/`) is always active. Workspace (`.groundwork/` in project root) is optional and project-scoped. `VaultManager` unifies both.
- **Webviews for rich UI.** The editor and briefing panels use VS Code webviews with inline HTML/JS. Scripts are bundled as UMD files in `lib/` (not loaded from `node_modules`).
- **Session logging.** All user actions (create, save, status change, context compile) are logged to `.sessions/YYYY-MM-DD.jsonl` for activity tracking.

## How To...

### Add a New Command

1. **Register in `extension.ts`** — add a `vscode.commands.registerCommand()` call inside the `ctx.subscriptions.push(...)` block
2. **Define in `package.json`** — add to `contributes.commands` with title, shortTitle, and icon
3. **Add menu entry** (optional) — add to `contributes.menus.view/title` or `contributes.menus.view/item/context` with a `when` clause

### Add a New Frontmatter Field

1. **Update `src/vault/types.ts`** — add the field to `NoteFrontmatter` interface (or rely on `[key: string]: unknown` for optional fields)
2. **Update `src/views/editor-panel.ts`** — add an input/select to the frontmatter card HTML, and include it in `gatherFrontmatter()` JS
3. **Update relevant views** — if the field should affect display (e.g., task-tree coloring, tooltip, briefing), update those files
4. **Update the Groundwork skill** — if AI tools should know about the field, update `~/.claude/skills/groundwork/SKILL.md`

### Add a New Tree View Filter

1. **Update `src/views/task-tree.ts`** — add the dimension to `TaskFilter` interface, add a `getAll*()` method, and add the filter logic in `applyFilters()`
2. **Update `src/extension.ts`** — add the new dimension to `showFilterPicker()` options

### Create a Webview Panel

Follow the pattern in `editor-panel.ts` or `briefing-panel.ts`:
- Use `vscode.window.createWebviewPanel()` with `localResourceRoots` pointing to `lib/`
- Load scripts via `webview.asWebviewUri()` — never use raw file paths
- CSP must allow `script-src` with a nonce
- Communicate with the extension via `vscode.postMessage()` / `webview.onDidReceiveMessage()`

## Packaging

The extension uses UMD bundles in `lib/` instead of loading from `node_modules` directly. This is because `vsce package` does not honor negation patterns in `.vscodeignore` for `node_modules/**`.

When adding a new npm dependency that needs to run in a webview:
1. Copy the UMD/browser build to `lib/`
2. Reference it via `webview.asWebviewUri()` in your panel
3. Make sure `lib/` is NOT excluded in `.vscodeignore`

## Commit Conventions

- Use descriptive commit messages that explain *why*, not just *what*
- Prefix with the area: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- Keep commits focused — one logical change per commit

## Testing

Tests are not yet implemented. When added, they should cover:
- Frontmatter parsing and serialization
- Filter logic (tag, context, project, search)
- Recurrence cloning
- Context compilation output format
