# Archive + Delete Guards & Task Shorthand References

## Feature 1: Archive for Vault Files + Delete Guards

### Problem
Currently "Delete" is available on all vault files and tasks indiscriminately. Vault files should be archived before deletion (safety net). Tasks should only be deletable when done or cancelled (GTD discipline).

### Design

#### Vault Structure
Add `archive/` directory to vault structure (auto-created on first archive):
```
.groundwork/
├── inbox/
├── notes/
├── projects/
├── reference/
├── logs/
├── archive/        ← NEW
└── .sessions/
```

#### Context Menus by Item Type

| Item type | Context menu actions |
|-----------|---------------------|
| Vault file (non-archived) | Archive, Rename, Move to Global/Workspace, Compile Context |
| Vault file (archived) | Unarchive, Delete, Rename |
| Task (done/cancelled) | Delete, Rename, Set Status, Move to Global/Workspace, Compile Context |
| Task (other statuses) | Set Status, Mark Done, Rename, Move to Global/Workspace, Compile Context |

#### Archive Behavior
- **Archive**: Moves file to `archive/` in the same vault. No frontmatter changes.
- **Unarchive**: Moves file back to `notes/` (simple default, no origin tracking).
- **Delete on vault files**: Only available on archived files. Permanent deletion with confirmation.
- **Delete on tasks**: Only available when status is done or cancelled.

#### contextValue Encoding

**Vault tree:**
- `vault-file-global` / `vault-file-workspace` (non-archived, unchanged)
- `vault-file-archived-global` / `vault-file-archived-workspace` (new)

**Task tree** — encode status into contextValue:
- `task-item-{scope}-{status}` e.g. `task-item-global-done`, `task-item-workspace-next`
- Existing `when` clauses using `viewItem =~ /^task-item/` still match

#### Menu `when` Clauses
- **Archive**: `viewItem =~ /^vault-file-(global|workspace)$/`
- **Unarchive**: `viewItem =~ /^vault-file-archived/`
- **Delete (vault)**: `viewItem =~ /^vault-file-archived/`
- **Delete (tasks)**: `viewItem =~ /^task-item-.+-(done|cancelled)$/`
- **Move to Global**: `viewItem =~ /^task-item-workspace/ || viewItem == vault-file-workspace`
- **Move to Workspace**: `viewItem =~ /^task-item-global/ || viewItem == vault-file-global`

#### Exclusions
Archived files are excluded from:
- Search and filter results
- Context compilation
- Daily briefing / weekly review

#### Vault Tree Display
Archive appears as a collapsed folder at the bottom of each vault root, like any other directory.

### Commands
- `groundwork.archiveNote` — new command, moves vault file to archive/
- `groundwork.unarchiveNote` — new command, moves archived file to notes/
- `groundwork.deleteNote` — existing, menu visibility restricted by `when` clauses

---

## Feature 2: Task Shorthand References

### Problem
When using AI skills (Claude Code, Copilot) to interact with tasks, referencing tasks by full title is verbose. Need a concise shorthand.

### Design

#### Skill-Only Convention
No extension code changes. The Groundwork skill instructions are updated to:

1. Always output numbered shorthand when listing tasks
2. Accept shorthand references in user messages
3. Resolve shorthands against the most recent listing in conversation

#### Prefix Mapping

| Prefix | Status |
|--------|--------|
| `I` | inbox |
| `N` | next |
| `A` | active |
| `W` | waiting |
| `S` | someday |
| `D` | done |
| `C` | cancelled |

#### Sort Order (within each group)
1. Priority: high → medium → low
2. Due date: soonest first (no due = last)
3. Title: alphabetical

#### Output Format
```
## Next Actions
N1. Fix login bug [high, due: 2026-03-20]
N2. Update API docs [medium]
N3. Add unit tests [low]

## Inbox
I1. Rename project folder
I2. Consider renaming to Brainpan
```

#### Usage Examples
- "mark N1 done"
- "what's I3 about?"
- "move S2 to next"
- "delete D1"

Numbers are ephemeral — recalculated on each listing, never persisted.

---

## Implementation Summary

### Extension Changes (Feature 1)
1. **vault-tree.ts**: Detect `archive/` path, set `vault-file-archived-{scope}` contextValue
2. **task-tree.ts**: Change contextValue to `task-item-{scope}-{status}`
3. **extension.ts**: Add `archiveNote` and `unarchiveNote` commands
4. **package.json**: Add new commands, update all `when` clauses
5. **store.ts**: Exclude `archive/` from queries used by search/filter/context

### Skill Changes (Feature 2)
1. **SKILL.md** (both locations): Add shorthand reference section with prefix table, sort order, output format, and usage instructions

### Documentation
1. **README.md**: Document archive workflow and shorthand references
