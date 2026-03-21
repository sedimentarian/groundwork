# Bug: Task tree drag-and-drop doesn't persist status change

**Status: CLOSED — Fixed 2026-03-20**

## Problem (original)

When dragging a task between GTD status groups in the task tree, the status in the frontmatter did not update persistently. The tree would visually move the task, but the file on disk retained the original status.

## Root causes found (three separate issues)

### 1. DataTransfer payload marshalling (task-tree.ts `handleDrop`)
The drag payload was stored as a raw `string[]` object. VS Code can marshal `DataTransferItem` values differently across contexts, causing `item.value` to arrive as a JSON string rather than a live array. The paths were never extracted and all drops silently no-oped.

**Fix:** Serialize the payload as `JSON.stringify(paths)` in `handleDrag` and add a robust `extractDraggedPaths()` helper in `handleDrop` that handles arrays, JSON strings, and `asString()` fallback.

### 2. Sort-order rewrite clobbering the status write (task-tree.ts `handleDrop`)
When dropping a task onto a specific item (not a group header), the sort-order rewrite loop called `readNote()` fresh from disk for the dragged task. On macOS APFS, this re-read could race the preceding status write and return pre-write contents — so the sort-order write would put the old `status` back on disk.

**Fix:** Reuse the already-updated in-memory `ParsedNote` objects from the status write step instead of re-reading from disk.

### 3. Editor panel showing and saving stale status (editor-panel.ts)
`EditorPanelManager.openFile()` called `existing.reveal()` and returned immediately when a panel was already open. The panel's closure-captured `note.frontmatter` still held the pre-DnD status. Clicking the task would show the old status in the editor, and saving would write it back to disk, reverting the change.

**Fix:**
- Added a `noteRefs` map to `EditorPanelManager` tracking the live frontmatter for each open panel.
- `openFile()` now re-reads from disk on reveal and posts a `frontmatterUpdated` message (with a 50ms delay to let the webview settle after un-hiding) updating all fields.
- `onTaskDropped` calls `editorPanels.notifyStatusChange()` to immediately sync the in-memory frontmatter and update the status dropdown via `postMessage`.

## Files changed

- `src/views/task-tree.ts` — payload serialization, `extractDraggedPaths()`, sort-order in-memory reuse
- `src/views/editor-panel.ts` — `noteRefs` map, `notifyStatusChange()`, `openFile()` reveal refresh, `frontmatterUpdated` webview handler
- `src/extension.ts` — wire `notifyStatusChange` via `onTaskDropped`

## Original state

The file `AI-agent.md` is in the `reference/` folder but has `type: project` in frontmatter. The user wants to drag it to a different folder and have the type update automatically.

## Code locations

- **Vault tree**: `src/views/vault-tree.ts` — `VaultTreeProvider` implements both `TreeDataProvider<VaultTreeItem>` and `TreeDragAndDropController<VaultTreeItem>`
- **Task tree**: `src/views/task-tree.ts` — `TaskTreeProvider` implements both `TreeDataProvider<TaskTreeItem>` and `TreeDragAndDropController<TaskTreeItem>`
- **Extension entry**: `src/extension.ts` — both views created with `vscode.window.createTreeView()` passing `dragAndDropController`

## Key differences between working task tree and broken vault tree

### Task tree (WORKS)
```typescript
type TaskTreeItem = TaskGroup | TaskItem;

class TaskGroup {
  readonly kind = 'group' as const;
  constructor(public status: TaskStatus, public tasks: ParsedNote[]) {}
}

class TaskItem {
  readonly kind = 'item' as const;
  constructor(public note: ParsedNote) {}
}

// handleDrag type guard — positive check on class instances
const taskItems = source.filter((s): s is TaskItem => 'kind' in s && s.kind === 'item');

// Data stored as simple string[] (paths only)
dataTransfer.set(TASK_MIME, new vscode.DataTransferItem(
  taskItems.map(t => t.note.path)
));

// MIME types
readonly dragMimeTypes = [TASK_MIME]; // 'application/vnd.groundwork.task'
readonly dropMimeTypes = [TASK_MIME];
```

### Vault tree (BROKEN)
```typescript
type VaultTreeItem = VaultRoot | VaultFile;

class VaultRoot {
  readonly kind = 'vault-root' as const;
  constructor(public scope, public label, public rootDir) {}
}

// VaultFile is a plain INTERFACE, not a class:
interface VaultFile {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  children?: VaultFile[];
  source: VaultScope;
  title?: string;
  noteType?: string;
}

// handleDrag type guard — positive check on VaultFile property
const files = source.filter((s): s is VaultFile => 'isDirectory' in s && !(s as VaultFile).isDirectory);

// Data stored as object[] (path + source)
dataTransfer.set(VAULT_MIME, new vscode.DataTransferItem(
  files.map(f => ({ path: f.path, source: f.source }))
));

// MIME types (tried adding VS Code default too)
readonly dragMimeTypes = [VAULT_MIME, 'application/vnd.code.tree.groundwork.vault'];
readonly dropMimeTypes = [VAULT_MIME, 'application/vnd.code.tree.groundwork.vault'];
```

### Tree view registration (both identical pattern)
```typescript
// Task (works)
const tasksView = vscode.window.createTreeView('groundwork.tasks', {
  treeDataProvider: taskTree,
  dragAndDropController: taskTree,
  showCollapseAll: false,
});

// Vault (broken)
const vaultView = vscode.window.createTreeView('groundwork.vault', {
  treeDataProvider: vaultTree,
  dragAndDropController: vaultTree,
  showCollapseAll: false,
});
```

## What we've tried

1. **Added diagnostic messages** at every early-return in `handleDrop` — none appear
2. **Changed type guard** from `!('kind' in s)` (negative) to `'isDirectory' in s` (positive) — no change
3. **Added VS Code default MIME type** `application/vnd.code.tree.groundwork.vault` to drag/dropMimeTypes — no change
4. **Verified compilation** — `npm run compile` succeeds, compiled JS contains all changes

## Possible root causes to investigate

1. **VaultFile is a plain interface/object vs TaskItem is a class instance** — VS Code's tree DnD might handle them differently
2. **VS Code Proxy wrapping** — tree elements may be wrapped in Proxy objects that affect property checks differently for plain objects vs class instances
3. **handleDrag might be throwing silently** — if VS Code catches errors in handleDrag, no data gets set, and handleDrop is never called
4. **Data serialization** — storing objects `{path, source}` vs simple strings in DataTransferItem might cause issues
5. **MIME type mismatch** — something about the custom MIME type registration
6. **package.json missing declaration** — maybe `canDrop` or similar contribution point is needed (though task tree works without it)
7. **VS Code version compatibility** — tree DnD API has evolved across versions

## Folder-to-type mapping

```typescript
function folderToNoteType(folder: string): string | undefined {
  switch (folder) {
    case 'inbox':     return 'task';
    case 'notes':     return 'note';
    case 'reference': return 'reference';
    case 'projects':  return 'project';
    case 'logs':      return 'log';
    default:          return undefined;
  }
}
```

## Expected behavior

1. User drags `AI-agent.md` from `reference/` to `notes/`
2. `handleDrop` fires
3. File is written to `notes/ai-agent.md` with `type: note` in frontmatter
4. Old file at `reference/ai-agent.md` is deleted
5. Tree refreshes showing file in new location
6. If editor panel was open, it reopens at new path

## Work log (March 20, 2026)

### Implemented changes

1. **Vault DnD item model aligned with Task tree pattern** in `src/views/vault-tree.ts`:
  - Introduced `VaultFileItem` class wrapper (discriminator `kind: 'vault-file'`)
  - Tree item union changed from `VaultRoot | VaultFile` to `VaultRoot | VaultFileItem`
  - `getChildren()` and `getTreeItem()` updated to consistently use wrapped file nodes

2. **DnD payload simplified** in `src/views/vault-tree.ts`:
  - `DataTransferItem` changed from object payload (`{ path, source }[]`) to `string[]` file paths
  - MIME types simplified to custom MIME only (`application/vnd.groundwork.vault-file`)

3. **Drop logic hardened** in `src/views/vault-tree.ts`:
  - Target resolution supports root, directory node, and file node parent folder
  - Removed unconditional same-path early skip
  - Added same-path retag path (updates frontmatter in place if folder-implied type differs)
  - Type inference expanded to include aliases and normalization:
    - `note`/`notes` -> `note`
    - `reference`/`references` -> `reference`
    - `project`/`projects` -> `project`
    - `log`/`logs` -> `log`
  - Type inference updated to prefer drop target node folder hint, fallback to path/root derivation

4. **Storage-layer safeguard added** in `src/vault/store.ts`:
  - `writeNote()` now infers canonical `type` from destination top-level folder and enforces it when known
  - Added helper `noteTypeFromVaultPath()`

5. **Build/runtime verification marker added** in `src/extension.ts`:
  - `BUILD_MARKER = 'dnd-type-fix-2026-03-20a'`
  - Activation output now includes:
    - `Build marker: dnd-type-fix-2026-03-20a`
    - `Activated at: <timestamp>`

6. **Validation completed after each patch**:
  - `npm run compile` succeeded
  - No TypeScript errors reported in changed files

### Observed runtime issue still blocking confirmation

User output channel logs did **not** include the build marker lines, while the marker is present in both:

- `src/extension.ts`
- `out/extension.js`

This indicates testing was still occurring against an older extension instance (or different installed copy), so the new DnD/type-fix code could not be verified in the running host.

### Next required verification step

1. Ensure the running instance shows:
  - `Build marker: dnd-type-fix-2026-03-20a`
2. Re-test dragging `ai-agent.md` from `notes/` -> `reference/`
3. Confirm resulting frontmatter in `reference/ai-agent.md` is `type: reference`
