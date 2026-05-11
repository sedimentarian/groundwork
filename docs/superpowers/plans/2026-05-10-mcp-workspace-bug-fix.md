# MCP Workspace Path Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Groundwork MCP server so it correctly includes workspace-scoped vault tasks instead of wiping them from the DB on every startup.

**Architecture:** Four layered fixes: (1) stop the reindex cleanup from deleting rows it didn't scan, (2) let the MCP server infer its workspace path from the DB when `--workspace-path` isn't passed, (3) expose `workspace_path` as an optional per-call parameter on key tools, (4) make the extension write `--workspace-path` into `~/.claude/settings.json` on activation (not only on the "Generate CLAUDE.md" command).

**Tech Stack:** TypeScript, Node.js, `better-sqlite3` via `GroundworkDB`, `@modelcontextprotocol/sdk`, VS Code extension API

---

## Background / Root Cause

The MCP server is launched by Claude Code via `~/.claude/settings.json`. On this machine, that config does **not** include `--workspace-path`. So at startup:

1. `src/mcp/server.ts:108–110` builds `sources = [{rootDir: globalPath, scope: 'global'}]` only.
2. `reindex(db, sources)` walks `~/.groundwork/` and builds `seenPaths`.
3. `src/db/sync.ts:85–92` deletes every DB row whose path is not in `seenPaths` — including all 30 workspace rows.
4. `db.saveToDisk()` persists the deletion.

The VS Code extension re-populates the workspace rows via its file watcher, but the MCP never sees them because it already wiped them on connect.

---

## Files Modified

| File | Change |
|------|--------|
| `src/db/sync.ts` | Restrict cleanup loop to paths under scanned vault roots |
| `src/mcp/server.ts` | Infer workspace path from DB; add `workspace_path` param to `list_tasks`, `search`, `daily_briefing`, `weekly_review` |
| `src/extension.ts` | Extract MCP config helper; call it on activation when workspace vault is present |

No new files. No new dependencies.

---

## Task 1: Fix the reindex cleanup loop (`src/db/sync.ts` lines 85–92)

**Files:**
- Modify: `src/db/sync.ts:85–92`

This is the highest-priority fix. The cleanup loop currently deletes any DB row whose path wasn't seen in *this* reindex run — regardless of which vault the row belongs to. When `reindex` is called with only the global vault, it wipes all workspace rows.

The fix: only delete rows whose file lives under one of the vault roots that was actually scanned.

- [ ] **Step 1: Read the current cleanup block**

Open `src/db/sync.ts` and confirm lines 85–92 look like:

```typescript
  // Delete DB rows for files that no longer exist
  const allDbPaths = db.all<{ path: string }>('SELECT path FROM notes');
  for (const { path: dbPath } of allDbPaths) {
    if (!seenPaths.has(dbPath)) {
      deleteNote(db, dbPath);
      stats.deleted++;
    }
  }
```

- [ ] **Step 2: Replace the cleanup block**

Replace lines 85–92 with:

```typescript
  // Delete DB rows for files that no longer exist, but only for the vault roots
  // that were actually scanned. Rows from unscanned vaults (e.g. workspace when
  // only global was passed) must be left intact.
  const scannedRoots = vaults.map(v => v.rootDir);
  const allDbPaths = db.all<{ path: string }>('SELECT path FROM notes');
  for (const { path: dbPath } of allDbPaths) {
    if (seenPaths.has(dbPath)) continue;
    const ownedByScannedRoot = scannedRoots.some(root => dbPath.startsWith(root + path.sep));
    if (ownedByScannedRoot) {
      deleteNote(db, dbPath);
      stats.deleted++;
    }
  }
```

- [ ] **Step 3: Compile to verify no TypeScript errors**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/sync.ts
git commit -m "fix: restrict reindex cleanup to scanned vault roots

Previously, reindex deleted any DB row whose path wasn't seen in the
current run. When the MCP server called reindex with only the global
vault, it wiped all workspace rows from the DB. Now cleanup is scoped
to paths under the vault roots that were actually walked."
```

---

## Task 2: Infer workspace path in MCP server from DB (`src/mcp/server.ts` lines 26–38)

**Files:**
- Modify: `src/mcp/server.ts:26–55`

When `--workspace-path` isn't in the MCP config args, `workspacePath` is `''` and `workspaceStore` is never initialized. Fix: after opening the DB, if `workspacePath` is empty, query the DB for any workspace-scoped row and walk up its path to find the `.groundwork` root.

- [ ] **Step 1: Change `workspacePath` from `const` to `let`**

At line 27, change:

```typescript
const workspacePath = getArg('workspace-path', '');
```

to:

```typescript
let workspacePath = getArg('workspace-path', '');
```

- [ ] **Step 2: Add inference logic after DB init**

After the DB init block (line 31, after `const db = new GroundworkDB(dbPath);`) but before the VaultStore init block (line 34), add:

```typescript
// If --workspace-path wasn't provided, try to infer it from existing DB rows.
// This repairs configs created before workspace-path was added to the MCP args.
if (!workspacePath) {
  // We can't open() the DB yet (that happens inside main()), so use a raw
  // synchronous sqlite3 to do the one-shot lookup before main() runs.
  // Instead, defer the inference to inside main() — see below.
}
```

Actually, since `db.open()` is async and happens inside `main()`, the inference must happen there. Skip this stub and handle it entirely inside `main()` in the next step.

- [ ] **Step 3: Add inference inside `main()` after `db.open()`**

At `src/mcp/server.ts:104–111`, the current `main()` starts:

```typescript
async function main() {
  await db.open();
  initSchema(db);

  // Reindex on startup
  const sources: VaultSource[] = [{ rootDir: globalPath, scope: 'global' }];
  if (workspaceStore) sources.push({ rootDir: workspacePath, scope: 'workspace' });
  await reindex(db, sources);
  db.saveToDisk();
```

Replace with:

```typescript
async function main() {
  await db.open();
  initSchema(db);

  // If --workspace-path wasn't passed, infer from existing DB rows so we don't
  // skip workspace tasks that a previous VS Code session already indexed.
  if (!workspacePath) {
    const sample = db.get<{ path: string }>(
      "SELECT path FROM notes WHERE scope = 'workspace' LIMIT 1"
    );
    if (sample?.path) {
      let p = path.dirname(sample.path);
      while (p && p !== path.dirname(p)) {
        if (path.basename(p) === '.groundwork' && fs.existsSync(p)) {
          workspacePath = p;
          workspaceStore = new VaultStore(workspacePath, 'workspace');
          break;
        }
        p = path.dirname(p);
      }
    }
  }

  // Reindex on startup — with Fix 1, only paths under each vault's root are cleaned up,
  // so passing global-only here no longer wipes workspace rows.
  const sources: VaultSource[] = [{ rootDir: globalPath, scope: 'global' }];
  if (workspaceStore) sources.push({ rootDir: workspacePath, scope: 'workspace' });
  await reindex(db, sources);
  db.saveToDisk();
```

- [ ] **Step 4: Compile**

```bash
npx tsc --noEmit
```

Expected: no errors. If `workspaceStore` assignment gives a type error on the `let` declaration at line 35 (`let workspaceStore: VaultStore | undefined`), confirm it's already `let` (it is — line 35 in the original).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "fix: infer workspace path from DB when --workspace-path arg is absent

When the MCP server is launched without --workspace-path (e.g. from
an existing ~/.claude/settings.json config), it now queries the DB
for any workspace-scoped row and walks up the path to find the
.groundwork root. This lets it include workspace tasks in all queries
without requiring a config change."
```

---

## Task 3: Add `workspace_path` param to MCP tools (`src/mcp/server.ts`)

**Files:**
- Modify: `src/mcp/server.ts` — `list_tasks` (line 119), `search` (line 404), `daily_briefing` (line 438), `weekly_review` (line 493)

This adds the optional `workspace_path` per-call parameter that callers expected. When passed, it lazily initializes a workspace store and reindexes just that vault (safe now that Task 1 is in place). A helper avoids duplication.

- [ ] **Step 1: Add a `lazyEnsureWorkspace` helper function**

After the `defaultScope()` function (line 51 in the original, after `rootForScope`), add:

```typescript
/** Ensure a workspace vault is initialized, optionally from a per-call path override. */
async function lazyEnsureWorkspace(perCallPath?: string): Promise<void> {
  const targetPath = perCallPath || workspacePath;
  if (!targetPath || !fs.existsSync(targetPath)) return;
  if (workspaceStore && (!perCallPath || perCallPath === workspacePath)) return; // already init'd

  workspacePath = targetPath;
  workspaceStore = new VaultStore(targetPath, 'workspace');
  await reindex(db, [{ rootDir: targetPath, scope: 'workspace' }]);
  db.saveToDisk();
}
```

- [ ] **Step 2: Add `workspace_path` to `list_tasks` inputSchema and handler**

In the `list_tasks` tool registration (starting ~line 119), add to `inputSchema`:

```typescript
workspace_path: z.string().optional().describe('Absolute path to a workspace .groundwork dir. When passed, includes workspace-scoped results.'),
```

And at the start of the `list_tasks` handler (before `const filter: TaskFilter`), add:

```typescript
await lazyEnsureWorkspace(params.workspace_path);
```

- [ ] **Step 3: Add `workspace_path` to `search` inputSchema and handler**

In the `search` tool registration (~line 404), add to `inputSchema`:

```typescript
workspace_path: z.string().optional().describe('Absolute path to a workspace .groundwork dir. When passed, includes workspace-scoped results.'),
```

At the start of the `search` handler, add:

```typescript
await lazyEnsureWorkspace(params.workspace_path);
```

- [ ] **Step 4: Add `workspace_path` to `daily_briefing` inputSchema and handler**

Change `inputSchema: {}` for `daily_briefing` to:

```typescript
inputSchema: {
  workspace_path: z.string().optional().describe('Absolute path to a workspace .groundwork dir.'),
},
```

At the start of the `daily_briefing` handler, add:

```typescript
await lazyEnsureWorkspace(params.workspace_path);
```

- [ ] **Step 5: Add `workspace_path` to `weekly_review` inputSchema and handler**

Change `inputSchema: {}` for `weekly_review` to:

```typescript
inputSchema: {
  workspace_path: z.string().optional().describe('Absolute path to a workspace .groundwork dir.'),
},
```

At the start of the `weekly_review` handler, add:

```typescript
await lazyEnsureWorkspace(params.workspace_path);
```

- [ ] **Step 6: Compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add workspace_path parameter to list_tasks, search, daily_briefing, weekly_review

Callers can now pass workspace_path per-call to ensure workspace-scoped
tasks are included in results, even if the MCP was launched without
--workspace-path. A lazy initializer handles first-call setup."
```

---

## Task 4: Update `~/.claude/settings.json` on extension activation (`src/extension.ts`)

**Files:**
- Modify: `src/extension.ts`

Currently, `~/.claude/settings.json` only gets `--workspace-path` when the user explicitly runs "Generate CLAUDE.md" (line 831+). Existing installs that ran the command before the workspace vault existed never got `--workspace-path` written. Fix: extract the MCP config write into a reusable helper and call it on activation whenever a workspace vault is present.

- [ ] **Step 1: Extract the MCP config write into a helper function**

In `src/extension.ts`, find the block inside `groundwork.generateClaudeMd` that writes `~/.claude/settings.json` (lines ~853–881). Extract it into a standalone async helper placed just above the `activate` function (before line 32):

```typescript
/** Write the Groundwork MCP server entry into ~/.claude/settings.json. */
async function updateClaudeMcpConfig(
  extensionPath: string,
  globalPath: string,
  workspacePath: string | undefined,
): Promise<void> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const claudeDir = path.join(home, '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  const serverScript = path.join(extensionPath, 'out', 'mcp', 'server.js');

  let settings: Record<string, unknown> = {};
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(claudeSettingsPath));
    const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch { /* file doesn't exist or isn't valid JSON — start fresh */ }

  const existingMcp = settings.mcpServers;
  const mcpServers: Record<string, unknown> =
    existingMcp && typeof existingMcp === 'object' && !Array.isArray(existingMcp)
      ? { ...(existingMcp as Record<string, unknown>) }
      : {};
  const mcpArgs = [serverScript, '--global-path', globalPath];
  if (workspacePath) mcpArgs.push('--workspace-path', workspacePath);
  mcpServers['groundwork'] = { command: 'node', args: mcpArgs };
  settings.mcpServers = mcpServers;

  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(claudeSettingsPath),
    Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf-8'),
  );
}
```

- [ ] **Step 2: Call the helper on activation when a workspace vault exists**

In `activate()`, after line 75 (`db.saveToDisk();` — the startup reindex), add:

```typescript
  // Keep ~/.claude/settings.json in sync with the current workspace vault path.
  // This repairs configs written before --workspace-path support was added.
  if (manager.workspacePath) {
    updateClaudeMcpConfig(ctx.extensionPath, globalPath, manager.workspacePath).catch(() => {
      // Non-fatal — MCP config is optional
    });
  }
```

- [ ] **Step 3: Replace the inline MCP config block in `generateClaudeMd` with the helper**

In the `groundwork.generateClaudeMd` command handler (~lines 853–881), replace the inline MCP config write block with:

```typescript
      try {
        await updateClaudeMcpConfig(ctx.extensionPath, globalPath, manager.workspacePath);
      } catch {
        // Non-fatal — MCP config is optional
      }
```

- [ ] **Step 4: Compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "fix: update ~/.claude/settings.json with --workspace-path on activation

Previously, the MCP config was only written when the user ran
'Generate CLAUDE.md'. Existing installs with a workspace vault but an
old config never got --workspace-path written. Now the extension
updates the config on activation whenever a workspace vault is present,
repairing stale configs automatically."
```

---

## Task 5: Build and verify

- [ ] **Step 1: Full compile**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext
npx tsc
```

Expected: no errors, `out/` updated.

- [ ] **Step 2: Package**

```bash
npx vsce package
```

Expected: a new `.vsix` file generated.

- [ ] **Step 3: Install locally**

```bash
code --install-extension groundwork-*.vsix
```

- [ ] **Step 4: Verify `~/.claude/settings.json` gets updated**

Open VS Code with this project as workspace. After a few seconds:

```bash
cat ~/.claude/settings.json | python3 -c "import json,sys; s=json.load(sys.stdin); print(json.dumps(s.get('mcpServers',{}).get('groundwork',{}), indent=2))"
```

Expected: the `args` array includes `--workspace-path` pointing to the `.groundwork` directory.

- [ ] **Step 5: Restart Claude Code and verify MCP returns workspace tasks**

Restart Claude Code (to reload MCP servers), then test:

```
/groundwork list next actions
```

Expected: N1–N4 workspace tasks appear via MCP (not just done global tasks).

- [ ] **Step 6: Final commit if any build artifacts changed**

```bash
git add out/
git commit -m "chore: rebuild after MCP workspace fix"
```

---

## Self-Review

**Spec coverage:**
- Fix 1 (sync.ts cleanup): Task 1 ✓
- Fix 2 (MCP infer workspace from DB): Task 2 ✓
- Fix 3 (workspace_path per-call param): Task 3 ✓
- Fix 4 (extension activation updates config): Task 4 ✓
- Build/verify: Task 5 ✓

**Placeholder scan:** No TBDs, no "implement later", all code blocks are complete.

**Type consistency:**
- `lazyEnsureWorkspace` uses the module-level `workspacePath` (already `let`) and `workspaceStore` (already `let`) — consistent throughout.
- `updateClaudeMcpConfig` signature matches all call sites.
- `VaultSource` interface in sync.ts uses `rootDir` — used correctly in Task 1 (`vaults.map(v => v.rootDir)`).
