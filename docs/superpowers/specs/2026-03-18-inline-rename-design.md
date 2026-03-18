# Inline Rename for Vault Files and Tasks

**Date:** 2026-03-18
**Status:** Approved

## Summary

Add inline rename to both the Vault and Tasks tree views. Right-click "Rename" or F2 on any file/task opens an InputBox pre-filled with the current title. On confirm, updates both the frontmatter `title` and the filename slug on disk.

## Scope

- **In scope:** Renaming files (notes, tasks, references, projects) in both tree views
- **Out of scope:** Renaming folders (deferred to someday task `rename-folders-inline.md`)

## Behavior

1. User triggers rename via context menu or F2 on a Vault file or Task item
2. InputBox appears pre-filled with the current frontmatter `title`
3. User edits the title and presses Enter (or Esc to cancel)
4. On confirm:
   - Validate: reject empty/whitespace-only input
   - Update frontmatter `title` to the new value
   - Update frontmatter `modified` to current ISO 8601 timestamp (same format used by `writeNote()` throughout the codebase)
   - Derive new filename slug: `lowercase → replace non-alphanum with hyphens → trim leading/trailing hyphens → append .md`
   - If slug changed:
     - Use `findAvailablePath` to resolve collisions (appends `-1`, `-2`, etc.)
     - Write updated frontmatter + body to the new file path via `manager.writeNote()`
     - Delete the old file via `manager.delete()`
     - If the resulting filename differs from what the user's title would produce (due to collision), show info message: "Renamed to {filename} (name already existed)"
   - If slug unchanged: overwrite in place via `manager.writeNote()` (title casing change only)
   - Log session event: `{ action: 'rename', file: newPath, detail: 'oldTitle → newTitle' }`
   - Refresh all trees

## Command

Single command `groundwork.renameNote` that accepts both `TaskItem` and `VaultFile` tree items, using the existing `resolveNote()` helper pattern.

## Triggers

- **Context menu:** "Rename" entry on `task-item-global`, `task-item-workspace`, `vault-file-global`, `vault-file-workspace`
- **Keybinding:** F2 with `when` clause `focusedView == groundwork.tasks || focusedView == groundwork.vault` (does not conflict with VS Code's built-in F2 "Rename Symbol" which activates only in editor focus)

## Files to Change

| File | Change |
|------|--------|
| `package.json` | Add `renameNote` command, context menu entries, F2 keybinding |
| `src/extension.ts` | Add `renameNote` command handler |
| `README.md` | Add "Rename Note" to Commands table, mention F2/right-click in relevant sections |
| `.claude/skills/groundwork/SKILL.md` | Add rename operation to "Common Operations" |
| `.github/skills/groundwork/SKILL.md` | Same as above (if exists) |

## Edge Cases

- **Slug collision:** `findAvailablePath` appends `-1`, `-2`. User is notified via info message when this happens.
- **Same slug after rename:** Skip file move, just update frontmatter in place (e.g., "Fix Bug" → "fix bug" both produce `fix-bug.md`)
- **Open editor tab:** Groundwork uses custom webview editor panels (not VS Code TextDocument editors). The editor panel references the file by path. After rename, the file watcher triggers `refreshAll()` which updates the tree views. If the old path is open in a Groundwork editor panel, it will fail to read on next refresh — this is acceptable since the user just renamed it and can reopen. No unsaved data risk since the editor saves on every change.
- **No item selected:** Show warning "Select a file to rename"

## Notes

The write-then-delete pattern (rather than `fs.rename`) is used because `manager.writeNote()` handles frontmatter serialization. The rename is really "write updated content to new path, then remove old file" — not a simple file move, since the content changes (new title, new modified timestamp). The two operations are fast and sequential; partial failure (crash between write and delete) leaves both files intact, which is safe (duplicate, not data loss).
