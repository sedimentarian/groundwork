# KB Vault v2 Enhancement Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the existing Knowledge Vault VSCode extension into KB Vault — a multi-root, GTD-native knowledge + context layer for AI coding tools, built for personal daily use first.

**Architecture:** Two-root vault system (global `~/.kbvault/` always present + optional per-workspace `.kbvault/`). VaultManager merges both roots for queries and tree views. All commands use `kbvault.*` namespace. Tree views support inline checkboxes for task completion and scope indicators (globe/folder) for global vs workspace items. AI instruction files (CLAUDE.md, copilot-instructions.md) auto-detect staleness on workspace open and offer to regenerate.

**Tech Stack:** TypeScript, VSCode Extension API (TreeView, commands, configuration, FileSystemWatcher), Node.js fs/path. No external dependencies.

---

## Design Decisions

### Multi-Root Vault Model

```
~/.kbvault/                          # Global vault (always active)
├── inbox/
├── projects/
├── reference/
├── logs/
├── .sessions/
└── .kbvault.json                    # Global vault metadata

<workspace-root>/
└── .kbvault/                        # Workspace vault (per-project, optional)
    ├── inbox/
    ├── projects/
    ├── reference/
    ├── logs/
    └── .kbvault.json                # Workspace vault metadata
```

- Global vault is always included in queries and tree views unless explicitly excluded
- Workspace vault is created on demand (first `kbvault.newTask` or `kbvault.newNote` scoped to workspace)
- When both vaults have a file at the same relative path, workspace wins
- Tree views show scope via icons: 🌐 globe for global, 📁 folder for workspace
- Context compilation merges both vaults; user can filter by scope

### Command Namespace

All commands rename from `knowledgeVault.*` → `kbvault.*`. The sidebar container ID, view IDs, configuration keys, and context values all use the `kbvault` prefix.

### GTD Swimlanes

Status groups displayed in order: **Inbox → Next Actions → Active → Waiting For → Someday/Maybe → Done → Cancelled**

Each group is collapsible. Tasks within groups show:
- Checkbox (unchecked = open, checked = done)
- Title
- Context tags as description
- Priority via icon color (high = red filled circle, medium = default, low = grey)
- Scope indicator (global/workspace)

Clicking checkbox on a task in Inbox/Next/Active/Waiting/Someday → moves to Done.
Right-click context menu → full status picker for any transition.

### AI File Staleness Detection

On workspace open:
1. Check if CLAUDE.md or .github/copilot-instructions.md exist in workspace
2. Compare file mtime against most recent vault modification (global + workspace)
3. If vault is newer → show notification: "KB Vault context has changed — regenerate CLAUDE.md?"
4. User clicks "Regenerate" or "Dismiss"

---

## File Structure

### Files to Modify (rename + refactor)

| File | Changes |
|------|---------|
| `src/vault/types.ts` | Add `VaultScope`, `VaultManagerConfig` types. Add `source` field to `ParsedNote`. |
| `src/vault/store.ts` | No structural changes — VaultStore stays single-root. Minor: export `parseFrontmatter`/`serializeFrontmatter`. |
| `src/extension.ts` | Full rewrite: use VaultManager, register `kbvault.*` commands, staleness check on activate. |
| `src/views/task-tree.ts` | Add checkbox support, scope icons, support VaultManager. |
| `src/views/vault-tree.ts` | Add scope icons, support VaultManager with two roots. |
| `src/views/session-tree.ts` | Update to VaultManager, namespace rename. |
| `src/context/generator.ts` | Accept VaultManager, merge both vaults for context compilation. |
| `src/session/tracker.ts` | Accept VaultManager, check both roots for isVaultFile. |
| `package.json` | Full rename of all command IDs, view IDs, config keys, sidebar container. |

### Files to Create

| File | Purpose |
|------|---------|
| `src/vault/manager.ts` | VaultManager class — orchestrates global + workspace VaultStore instances. Merges queries, delegates writes. |
| `src/vault/staleness.ts` | Staleness detection — compares AI file mtime against vault mtime. |
| ~~`tests/vault/store.test.ts`~~ | Deferred to separate test plan. |
| ~~`tests/vault/manager.test.ts`~~ | Deferred to separate test plan. |
| ~~`tests/context/generator.test.ts`~~ | Deferred to separate test plan. |

---

**⚠️ Build note:** The project will not compile cleanly until Task 11 is complete. Intermediate `npx tsc --noEmit` checks verify the changed file's structure, not whole-project compilation. This is expected — the migration from `VaultStore` → `VaultManager` touches every file, and they must all update before the project compiles again.

## Chunk 1: Types, Store Refactor, and Namespace Rename

### Task 1: Add multi-root types to types.ts

**Files:**
- Modify: `src/vault/types.ts`

- [ ] **Step 1: Add VaultScope and VaultManagerConfig types**

Add these types after the existing `SessionEntry` interface:

```typescript
/** Which vault root a file belongs to */
export type VaultScope = 'global' | 'workspace';

/** Configuration for VaultManager */
export interface VaultManagerConfig {
  globalPath: string;
  workspacePath?: string;
}
```

- [ ] **Step 2: Add `source` field to ParsedNote**

Update the `ParsedNote` interface to include the source vault:

```typescript
export interface ParsedNote {
  path: string;
  relativePath: string;
  frontmatter: NoteFrontmatter;
  body: string;
  raw: string;
  source: VaultScope;  // <-- add this
}
```

- [ ] **Step 3: Add `source` to VaultFile**

```typescript
export interface VaultFile {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  children?: VaultFile[];
  source: VaultScope;  // <-- add this
}
```

- [ ] **Step 4: Compile to verify no errors**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

Expected: Errors in files that construct ParsedNote/VaultFile without `source` — that's expected and will be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add src/vault/types.ts
git commit -m "feat: add VaultScope, VaultManagerConfig types and source fields"
```

---

### Task 2: Update VaultStore to populate `source` field

**Files:**
- Modify: `src/vault/store.ts`

- [ ] **Step 1: Add `VaultScope` to imports and add `scope` property to VaultStore constructor**

Update the import line at the top of store.ts:

```typescript
import { VaultFile, ParsedNote, NoteFrontmatter, SessionEntry, VaultScope } from './types';
```

Then update the constructor:

```typescript
export class VaultStore {
  constructor(
    public rootDir: string,
    public readonly scope: VaultScope = 'global'
  ) {}
```

- [ ] **Step 2: Update `listFiles` to include `source`**

In the `listFiles` method, add `source: this.scope` to every VaultFile object:

```typescript
// In the isDirectory branch:
results.push({
  path: fullPath,
  relativePath,
  name: entry.name,
  isDirectory: true,
  children,
  source: this.scope,
});

// In the .md file branch:
results.push({
  path: fullPath,
  relativePath,
  name: entry.name,
  isDirectory: false,
  source: this.scope,
});
```

- [ ] **Step 3: Update `readNote` to include `source`**

```typescript
async readNote(filePath: string): Promise<ParsedNote> {
  this.assertWithinVault(filePath);
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    path: filePath,
    relativePath: path.relative(this.rootDir, filePath),
    frontmatter,
    body,
    raw,
    source: this.scope,
  };
}
```

- [ ] **Step 4: Export parseFrontmatter and serializeFrontmatter**

Change `function parseFrontmatter` → `export function parseFrontmatter`
Change `function serializeFrontmatter` → `export function serializeFrontmatter`

These will be needed by VaultManager for cross-store operations.

- [ ] **Step 5: Compile to verify**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

Expected: Clean or only errors in extension.ts (which still constructs VaultStore without scope).

- [ ] **Step 6: Commit**

```bash
git add src/vault/store.ts
git commit -m "feat: add scope to VaultStore, populate source on VaultFile/ParsedNote"
```

---

### Task 3: Create VaultManager

**Files:**
- Create: `src/vault/manager.ts`

- [ ] **Step 1: Create VaultManager class**

```typescript
import * as path from 'path';
import { VaultStore } from './store';
import {
  VaultManagerConfig,
  VaultScope,
  ParsedNote,
  NoteFrontmatter,
  VaultFile,
  SessionEntry,
} from './types';

export class VaultManager {
  private global: VaultStore;
  private workspace: VaultStore | undefined;

  constructor(private config: VaultManagerConfig) {
    this.global = new VaultStore(config.globalPath, 'global');
    if (config.workspacePath) {
      this.workspace = new VaultStore(config.workspacePath, 'workspace');
    }
  }

  get globalStore(): VaultStore {
    return this.global;
  }

  get workspaceStore(): VaultStore | undefined {
    return this.workspace;
  }

  get globalPath(): string {
    return this.config.globalPath;
  }

  get workspacePath(): string | undefined {
    return this.config.workspacePath;
  }

  /** Initialize both vault roots */
  async init(): Promise<void> {
    await this.global.init();
    if (this.workspace) {
      await this.workspace.init();
    }
  }

  /** Initialize workspace vault on demand (creates .kbvault/ in workspace) */
  async initWorkspace(workspacePath: string): Promise<void> {
    this.config.workspacePath = workspacePath;
    this.workspace = new VaultStore(workspacePath, 'workspace');
    await this.workspace.init();
  }

  /** List files from both vaults, workspace items first */
  async listFiles(scope?: VaultScope): Promise<VaultFile[]> {
    if (scope === 'global') return this.global.listFiles();
    if (scope === 'workspace') {
      return this.workspace ? this.workspace.listFiles() : [];
    }

    // Merge both
    const globalFiles = await this.global.listFiles();
    const workspaceFiles = this.workspace
      ? await this.workspace.listFiles()
      : [];
    return [...workspaceFiles, ...globalFiles];
  }

  /** Query notes from both vaults, deduplicating by relativePath (workspace wins) */
  async queryNotes(
    filter: Partial<NoteFrontmatter>,
    scope?: VaultScope
  ): Promise<ParsedNote[]> {
    if (scope === 'global') return this.global.queryNotes(filter);
    if (scope === 'workspace') {
      return this.workspace ? this.workspace.queryNotes(filter) : [];
    }

    const globalNotes = await this.global.queryNotes(filter);
    const workspaceNotes = this.workspace
      ? await this.workspace.queryNotes(filter)
      : [];

    // Workspace wins on duplicate relativePath
    const seen = new Set<string>();
    const merged: ParsedNote[] = [];

    for (const note of workspaceNotes) {
      seen.add(note.relativePath);
      merged.push(note);
    }
    for (const note of globalNotes) {
      if (!seen.has(note.relativePath)) {
        merged.push(note);
      }
    }

    return merged;
  }

  /** Read a note — delegates to the correct store based on path */
  async readNote(filePath: string): Promise<ParsedNote> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.readNote(filePath);
    }
    return this.global.readNote(filePath);
  }

  /** Write a note — delegates to the correct store based on path */
  async writeNote(
    filePath: string,
    frontmatter: NoteFrontmatter,
    body: string
  ): Promise<void> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.writeNote(filePath, frontmatter, body);
    }
    return this.global.writeNote(filePath, frontmatter, body);
  }

  /** Delete a note */
  async delete(filePath: string): Promise<void> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.delete(filePath);
    }
    return this.global.delete(filePath);
  }

  /** Log a session — always to global store */
  async logSession(entry: SessionEntry): Promise<void> {
    return this.global.logSession(entry);
  }

  /** Get recent sessions — from global store */
  async getRecentSessions(days?: number): Promise<SessionEntry[]> {
    return this.global.getRecentSessions(days);
  }

  /** Check if a file path belongs to either vault */
  isVaultFile(filePath: string): boolean {
    if (filePath.startsWith(this.global.rootDir)) return true;
    if (this.workspace && filePath.startsWith(this.workspace.rootDir))
      return true;
    return false;
  }

  /** Determine which scope a file belongs to */
  scopeOf(filePath: string): VaultScope | undefined {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir))
      return 'workspace';
    if (filePath.startsWith(this.global.rootDir)) return 'global';
    return undefined;
  }

  /** Get the store for a given scope */
  storeFor(scope: VaultScope): VaultStore | undefined {
    return scope === 'workspace' ? this.workspace : this.global;
  }

  /** Get root dir for a given scope */
  rootDirFor(scope: VaultScope): string | undefined {
    return scope === 'workspace'
      ? this.workspace?.rootDir
      : this.global.rootDir;
  }
}
```

- [ ] **Step 2: Compile to verify**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

Expected: VaultManager compiles. Other files may still error (they reference old types).

- [ ] **Step 3: Commit**

```bash
git add src/vault/manager.ts
git commit -m "feat: add VaultManager for multi-root vault orchestration"
```

---

### Task 4: Rename namespace from knowledgeVault to kbvault in package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace all `knowledgeVault` references with `kbvault`**

Full replacement list in package.json:
- `"displayName": "Knowledge Vault"` → `"displayName": "KB Vault"`
- All `"command": "knowledgeVault.*"` → `"command": "kbvault.*"`
- All `"title": "Knowledge Vault: ..."` → `"title": "KB Vault: ..."`
- `"id": "knowledge-vault"` → `"id": "kb-vault"`
- `"title": "Knowledge Vault"` → `"title": "KB Vault"`
- All `"id": "knowledgeVault.*"` → `"id": "kbvault.*"`
- All `"view == knowledgeVault.*"` → `"view == kbvault.*"`
- All `"view =~ /knowledgeVault/"` → `"view =~ /kbvault/"`
- All `"knowledgeVault.*"` config keys → `"kbvault.*"`
- Configuration title: `"Knowledge Vault"` → `"KB Vault"`

The full updated package.json contributes section:

```json
{
  "name": "kb-vault",
  "displayName": "KB Vault",
  "description": "GTD-powered knowledge and context management for AI coding assistants",
  "version": "0.2.0",
  "publisher": "lwbailey",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "kbvault.openVault", "title": "KB Vault: Open Vault Folder" },
      { "command": "kbvault.newNote", "title": "KB Vault: New Note" },
      { "command": "kbvault.newTask", "title": "KB Vault: New Task" },
      { "command": "kbvault.compileContext", "title": "KB Vault: Compile Context for AI" },
      { "command": "kbvault.generateClaudeMd", "title": "KB Vault: Generate CLAUDE.md" },
      { "command": "kbvault.generateCopilotInstructions", "title": "KB Vault: Generate Copilot Instructions" },
      { "command": "kbvault.logActivity", "title": "KB Vault: Log Activity" },
      { "command": "kbvault.refresh", "title": "KB Vault: Refresh", "icon": "$(refresh)" },
      { "command": "kbvault.setTaskStatus", "title": "KB Vault: Set Task Status" },
      { "command": "kbvault.deleteNote", "title": "KB Vault: Delete Note" },
      { "command": "kbvault.markDone", "title": "KB Vault: Mark Done", "icon": "$(check)" },
      { "command": "kbvault.initWorkspace", "title": "KB Vault: Initialize Workspace Vault" }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "kb-vault",
          "title": "KB Vault",
          "icon": "$(book)"
        }
      ]
    },
    "views": {
      "kb-vault": [
        { "id": "kbvault.tasks", "name": "Tasks" },
        { "id": "kbvault.vault", "name": "Vault" },
        { "id": "kbvault.sessions", "name": "Recent Activity" }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "kbvault.refresh",
          "when": "view =~ /kbvault/",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "kbvault.setTaskStatus",
          "when": "view == kbvault.tasks && viewItem == task-item"
        },
        {
          "command": "kbvault.markDone",
          "when": "view == kbvault.tasks && viewItem == task-item"
        },
        {
          "command": "kbvault.compileContext",
          "when": "view == kbvault.vault || view == kbvault.tasks"
        },
        {
          "command": "kbvault.deleteNote",
          "when": "viewItem == vault-file || viewItem == task-item"
        }
      ]
    },
    "configuration": {
      "title": "KB Vault",
      "properties": {
        "kbvault.globalPath": {
          "type": "string",
          "default": "",
          "description": "Path to the global vault directory. Defaults to ~/.kbvault"
        },
        "kbvault.gtd.contexts": {
          "type": "array",
          "default": ["@computer", "@phone", "@office", "@home", "@errands", "@anywhere"],
          "description": "GTD contexts for task categorization"
        },
        "kbvault.context.maxTokenEstimate": {
          "type": "number",
          "default": 4000,
          "description": "Approximate max tokens when compiling AI context"
        },
        "kbvault.autoDetectStaleness": {
          "type": "boolean",
          "default": true,
          "description": "Auto-detect stale CLAUDE.md/copilot-instructions.md on workspace open"
        },
        "kbvault.newTaskDefaultScope": {
          "type": "string",
          "enum": ["workspace", "global"],
          "default": "workspace",
          "description": "Default scope when creating new tasks (if workspace vault exists)"
        },
        "kbvault.newNoteDefaultScope": {
          "type": "string",
          "enum": ["global", "workspace"],
          "default": "global",
          "description": "Default scope when creating new notes"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "lint": "eslint src --ext ts",
    "lint": "eslint src --ext ts"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/vscode": "^1.85.0",
    "typescript": "^5.3.3"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: rename namespace from knowledgeVault to kbvault"
```

---

## Chunk 2: View Layer Refactoring

### Task 5: Update SessionTracker to use VaultManager

**Files:**
- Modify: `src/session/tracker.ts`

- [ ] **Step 1: Replace VaultStore with VaultManager**

```typescript
import * as vscode from 'vscode';
import { VaultManager } from '../vault/manager';
import { SessionEntry } from '../vault/types';

export class SessionTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private manager: VaultManager) {}

  activate(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (this.manager.isVaultFile(doc.uri.fsPath)) {
          this.log({ action: 'open', file: doc.uri.fsPath });
        }
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (this.manager.isVaultFile(doc.uri.fsPath)) {
          this.log({ action: 'save', file: doc.uri.fsPath });
        }
      })
    );
  }

  async log(entry: Omit<SessionEntry, 'timestamp'>): Promise<void> {
    await this.manager.logSession({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

- [ ] **Step 2: Compile to verify**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/session/tracker.ts
git commit -m "refactor: update SessionTracker to use VaultManager"
```

---

### Task 6: Update ContextGenerator to use VaultManager

**Files:**
- Modify: `src/context/generator.ts`

- [ ] **Step 1: Replace VaultStore with VaultManager**

Change the constructor and all `this.store` references:

```typescript
import { ParsedNote } from '../vault/types';
import { VaultManager } from '../vault/manager';

export interface ContextBlock {
  title: string;
  content: string;
  tokenEstimate: number;
}

export class ContextGenerator {
  constructor(private manager: VaultManager) {}

  async compileContext(notePaths: string[], options?: {
    includeMetadata?: boolean;
    maxTokens?: number;
    format?: 'markdown' | 'xml';
  }): Promise<string> {
    const opts = {
      includeMetadata: true,
      maxTokens: 4000,
      format: 'markdown' as const,
      ...options,
    };

    const notes = await Promise.all(
      notePaths.map(p => this.manager.readNote(p))
    );

    if (opts.format === 'xml') {
      return this.formatXml(notes, opts);
    }
    return this.formatMarkdown(notes, opts);
  }

  async compileActiveContext(): Promise<string> {
    const activeTasks = await this.manager.queryNotes({ type: 'task', status: 'active' });
    const nextTasks = await this.manager.queryNotes({ type: 'task', status: 'next' });
    const allTasks = [...activeTasks, ...nextTasks];

    if (allTasks.length === 0) {
      return '<!-- No active or next tasks found in vault -->';
    }

    const lines: string[] = [
      '# Current Work Context',
      '',
      `_Generated ${new Date().toISOString().slice(0, 16)}_`,
      '',
    ];

    const byProject = new Map<string, ParsedNote[]>();
    for (const task of allTasks) {
      const project = task.frontmatter.project ?? 'Unassigned';
      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project)!.push(task);
    }

    for (const [project, tasks] of byProject) {
      lines.push(`## ${project}`, '');
      for (const task of tasks) {
        const status = task.frontmatter.status ?? 'unknown';
        const title = task.frontmatter.title ?? task.relativePath;
        const scope = task.source === 'workspace' ? '📁' : '🌐';
        const contexts = task.frontmatter.context
          ? ` (${(task.frontmatter.context as string[]).join(', ')})`
          : '';
        lines.push(`- ${scope} **[${status}]** ${title}${contexts}`);

        const firstPara = task.body.trim().split('\n\n')[0];
        if (firstPara && firstPara.length < 200) {
          lines.push(`  > ${firstPara}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async generateClaudeMd(projectPath: string): Promise<string> {
    const activeContext = await this.compileActiveContext();
    const referenceDocs = await this.manager.queryNotes({ type: 'reference' });

    const lines: string[] = [
      '# CLAUDE.md',
      '',
      '> Auto-generated by KB Vault. Do not edit directly.',
      '',
      activeContext,
      '',
    ];

    if (referenceDocs.length > 0) {
      lines.push('## Reference Knowledge', '');
      for (const doc of referenceDocs.slice(0, 10)) {
        const title = doc.frontmatter.title ?? doc.relativePath;
        lines.push(`### ${title}`, '');
        const truncated = doc.body.trim().slice(0, 500);
        lines.push(truncated);
        if (doc.body.trim().length > 500) lines.push('...');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  async generateCopilotInstructions(): Promise<string> {
    const activeContext = await this.compileActiveContext();

    return [
      '# Copilot Instructions',
      '',
      '> Auto-generated by KB Vault. Do not edit directly.',
      '',
      activeContext,
    ].join('\n');
  }

  private formatMarkdown(notes: ParsedNote[], opts: { includeMetadata: boolean }): string {
    const lines: string[] = [
      '# KB Vault Context',
      '',
      `_Compiled ${new Date().toISOString().slice(0, 16)} — ${notes.length} file(s)_`,
      '',
    ];

    for (const note of notes) {
      const title = note.frontmatter.title ?? note.relativePath;
      const scope = note.source === 'workspace' ? '📁' : '🌐';
      lines.push(`## ${scope} ${title}`, '');

      if (opts.includeMetadata) {
        const meta: string[] = [];
        if (note.frontmatter.type) meta.push(`type: ${note.frontmatter.type}`);
        if (note.frontmatter.status) meta.push(`status: ${note.frontmatter.status}`);
        if (note.frontmatter.tags) meta.push(`tags: ${(note.frontmatter.tags as string[]).join(', ')}`);
        if (note.frontmatter.project) meta.push(`project: ${note.frontmatter.project}`);
        if (meta.length) {
          lines.push(`> ${meta.join(' | ')}`, '');
        }
      }

      lines.push(note.body.trim(), '', '---', '');
    }

    return lines.join('\n');
  }

  private formatXml(notes: ParsedNote[], opts: { includeMetadata: boolean }): string {
    const lines: string[] = ['<knowledge-context>'];

    for (const note of notes) {
      const title = note.frontmatter.title ?? note.relativePath;
      lines.push(`  <document title="${escapeXml(title)}" path="${escapeXml(note.relativePath)}" scope="${note.source}">`);

      if (opts.includeMetadata && note.frontmatter.type) {
        lines.push(`    <metadata type="${note.frontmatter.type}" status="${note.frontmatter.status ?? ''}" />`);
      }

      lines.push(`    <content>`);
      lines.push(`      ${escapeXml(note.body.trim())}`);
      lines.push(`    </content>`);
      lines.push(`  </document>`);
    }

    lines.push('</knowledge-context>');
    return lines.join('\n');
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 2: Compile to verify**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/context/generator.ts
git commit -m "refactor: update ContextGenerator to use VaultManager with scope indicators"
```

---

### Task 7: Update TaskTreeProvider with checkboxes and scope icons

**Files:**
- Modify: `src/views/task-tree.ts`

- [ ] **Step 1: Replace VaultStore with VaultManager, add checkbox + scope support**

```typescript
import * as vscode from 'vscode';
import { VaultManager } from '../vault/manager';
import { ParsedNote, TaskStatus, GTD_LISTS } from '../vault/types';

type TaskTreeItem = TaskGroup | TaskItem;

class TaskGroup {
  constructor(public status: TaskStatus, public tasks: ParsedNote[]) {}
}

class TaskItem {
  constructor(public note: ParsedNote) {}
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: Map<TaskStatus, ParsedNote[]> = new Map();

  constructor(private manager: VaultManager) {}

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element instanceof TaskGroup) {
      const label = `${GTD_LISTS[element.status]} (${element.tasks.length})`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(statusIcon(element.status));
      item.contextValue = 'task-group';
      return item;
    }

    const note = element.note;
    const title = note.frontmatter.title ?? note.relativePath;
    const isDone = note.frontmatter.status === 'done' || note.frontmatter.status === 'cancelled';
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);

    // Click opens file
    item.command = {
      command: 'vscode.open',
      title: 'Open Task',
      arguments: [vscode.Uri.file(note.path)],
    };

    // Build description: scope icon + context tags
    const scopeIcon = note.source === 'workspace' ? '📁' : '🌐';
    const contexts = note.frontmatter.context;
    const contextStr = contexts && Array.isArray(contexts) && contexts.length > 0
      ? contexts.join(', ')
      : '';
    item.description = `${scopeIcon} ${contextStr}`.trim();

    // Checkbox-style icon: done = checked, open = unchecked, priority coloring
    if (isDone) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else if (note.frontmatter.priority === 'high') {
      item.iconPath = new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('errorForeground'));
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-large-outline');
    }

    item.contextValue = 'task-item';
    item.tooltip = note.body.trim().slice(0, 200);

    return item;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      const allTasks = await this.manager.queryNotes({ type: 'task' });

      this.cache.clear();
      for (const task of allTasks) {
        const status = (task.frontmatter.status as TaskStatus) ?? 'inbox';
        if (!this.cache.has(status)) this.cache.set(status, []);
        this.cache.get(status)!.push(task);
      }

      const order: TaskStatus[] = ['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled'];
      return order
        .filter(s => this.cache.has(s) && this.cache.get(s)!.length > 0)
        .map(s => new TaskGroup(s, this.cache.get(s)!));
    }

    if (element instanceof TaskGroup) {
      return element.tasks.map(t => new TaskItem(t));
    }

    return [];
  }
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'inbox': return 'inbox';
    case 'next': return 'arrow-right';
    case 'active': return 'play';
    case 'waiting': return 'clock';
    case 'someday': return 'cloud';
    case 'done': return 'check';
    case 'cancelled': return 'close';
    default: return 'question';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/views/task-tree.ts
git commit -m "feat: task tree with checkbox icons, scope indicators, cancelled group"
```

---

### Task 8: Update VaultTreeProvider with scope icons and multi-root

**Files:**
- Modify: `src/views/vault-tree.ts`

- [ ] **Step 1: Rewrite to show two root nodes (Global / Workspace)**

```typescript
import * as vscode from 'vscode';
import { VaultManager } from '../vault/manager';
import { VaultFile, VaultScope } from '../vault/types';

/** A root node representing a vault scope */
class VaultRoot {
  constructor(
    public readonly scope: VaultScope,
    public readonly label: string
  ) {}
}

type VaultTreeItem = VaultRoot | VaultFile;

export class VaultTreeProvider implements vscode.TreeDataProvider<VaultTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<VaultTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: VaultManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: VaultTreeItem): vscode.TreeItem {
    if (element instanceof VaultRoot) {
      const icon = element.scope === 'global' ? 'globe' : 'folder-library';
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(icon);
      item.contextValue = `vault-root-${element.scope}`;
      return item;
    }

    // VaultFile
    const file = element;
    const item = new vscode.TreeItem(
      file.name,
      file.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!file.isDirectory) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Note',
        arguments: [vscode.Uri.file(file.path)],
      };
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'vault-file';
    } else {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'vault-folder';
    }

    item.tooltip = file.relativePath;
    return item;
  }

  async getChildren(element?: VaultTreeItem): Promise<VaultTreeItem[]> {
    if (!element) {
      // Root level: show scope roots
      const roots: VaultTreeItem[] = [new VaultRoot('global', 'Global')];
      if (this.manager.workspaceStore) {
        roots.unshift(new VaultRoot('workspace', 'Workspace'));
      }
      return roots;
    }

    if (element instanceof VaultRoot) {
      const store = this.manager.storeFor(element.scope);
      if (!store) return [];
      try {
        return await store.listFiles();
      } catch {
        return [];
      }
    }

    // VaultFile directory
    const dir = element as VaultFile;
    if (dir.isDirectory && dir.children) {
      return dir.children;
    }

    return [];
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/views/vault-tree.ts
git commit -m "feat: vault tree with Global/Workspace root nodes and scope icons"
```

---

### Task 9: Update SessionTreeProvider to use VaultManager

**Files:**
- Modify: `src/views/session-tree.ts`

- [ ] **Step 1: Replace VaultStore with VaultManager**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { SessionEntry } from '../vault/types';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: VaultManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(entry: SessionEntry): vscode.TreeItem {
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fileName = entry.file ? path.basename(entry.file) : '';

    const label = `${timeStr} — ${entry.action}${fileName ? ': ' + fileName : ''}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.iconPath = new vscode.ThemeIcon(actionIcon(entry.action));

    if (entry.file) {
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(entry.file)],
      };
    }

    if (entry.detail) {
      item.tooltip = entry.detail;
    }

    return item;
  }

  async getChildren(): Promise<SessionEntry[]> {
    try {
      const entries = await this.manager.getRecentSessions(3);
      return entries.slice(0, 50);
    } catch {
      return [];
    }
  }
}

function actionIcon(action: string): string {
  switch (action) {
    case 'open': return 'eye';
    case 'save': return 'save';
    case 'create': return 'new-file';
    case 'status_change': return 'arrow-swap';
    case 'context_compile': return 'package';
    case 'activity_log': return 'note';
    default: return 'circle-outline';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/views/session-tree.ts
git commit -m "refactor: update SessionTreeProvider to use VaultManager"
```

---

## Chunk 3: Staleness Detection and Extension Host Rewrite

### Task 10: Create staleness detector

**Files:**
- Create: `src/vault/staleness.ts`

- [ ] **Step 1: Implement staleness detection**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { VaultManager } from './manager';

export interface StalenessResult {
  file: string;
  isStale: boolean;
  aiFileMtime: Date | null;
  vaultMtime: Date;
}

/**
 * Check if AI instruction files are stale relative to vault content.
 * A file is stale if any vault content was modified after the AI file.
 */
export async function checkStaleness(
  manager: VaultManager,
  workspacePath: string
): Promise<StalenessResult[]> {
  const results: StalenessResult[] = [];
  const vaultMtime = await getLatestVaultMtime(manager);

  const aiFiles = [
    path.join(workspacePath, 'CLAUDE.md'),
    path.join(workspacePath, '.github', 'copilot-instructions.md'),
  ];

  for (const aiFile of aiFiles) {
    try {
      const stat = await fs.promises.stat(aiFile);
      results.push({
        file: path.basename(aiFile),
        isStale: vaultMtime > stat.mtime,
        aiFileMtime: stat.mtime,
        vaultMtime,
      });
    } catch {
      // File doesn't exist — not stale, just absent
      // Only report if vault has content worth generating from
      const hasContent = await hasActiveContent(manager);
      if (hasContent) {
        results.push({
          file: path.basename(aiFile),
          isStale: true,
          aiFileMtime: null,
          vaultMtime,
        });
      }
    }
  }

  return results;
}

async function getLatestVaultMtime(manager: VaultManager): Promise<Date> {
  let latest = new Date(0);

  for (const scope of ['global', 'workspace'] as const) {
    const rootDir = manager.rootDirFor(scope);
    if (!rootDir) continue;

    const mtime = await getLatestMtimeInDir(rootDir);
    if (mtime > latest) latest = mtime;
  }

  return latest;
}

async function getLatestMtimeInDir(dir: string): Promise<Date> {
  let latest = new Date(0);

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subMtime = await getLatestMtimeInDir(fullPath);
        if (subMtime > latest) latest = subMtime;
      } else if (entry.name.endsWith('.md')) {
        const stat = await fs.promises.stat(fullPath);
        if (stat.mtime > latest) latest = stat.mtime;
      }
    }
  } catch {
    // Directory doesn't exist or inaccessible
  }

  return latest;
}

async function hasActiveContent(manager: VaultManager): Promise<boolean> {
  const tasks = await manager.queryNotes({ type: 'task', status: 'active' });
  const next = await manager.queryNotes({ type: 'task', status: 'next' });
  return tasks.length > 0 || next.length > 0;
}
```

- [ ] **Step 2: Compile to verify**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/vault/staleness.ts
git commit -m "feat: add staleness detection for AI instruction files"
```

---

### Task 11: Rewrite extension.ts with VaultManager, kbvault namespace, and staleness check

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Full rewrite of extension.ts**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { VaultManager } from './vault/manager';
import { TaskStatus, GTD_LISTS, VaultScope } from './vault/types';
import { ContextGenerator } from './context/generator';
import { SessionTracker } from './session/tracker';
import { VaultTreeProvider } from './views/vault-tree';
import { TaskTreeProvider } from './views/task-tree';
import { SessionTreeProvider } from './views/session-tree';
import { checkStaleness } from './vault/staleness';

let manager: VaultManager;
let contextGen: ContextGenerator;
let sessionTracker: SessionTracker;

export async function activate(ctx: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('kbvault');

  // Resolve global vault path
  const configuredGlobal = config.get<string>('globalPath');
  const globalPath = configuredGlobal || path.join(os.homedir(), '.kbvault');

  // Resolve workspace vault path
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = workspaceFolder
    ? path.join(workspaceFolder.uri.fsPath, '.kbvault')
    : undefined;

  // Check if workspace vault exists (don't create it automatically)
  let workspaceVaultExists = false;
  if (workspacePath) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(workspacePath));
      workspaceVaultExists = stat.type === vscode.FileType.Directory;
    } catch {
      // Doesn't exist yet — that's fine
    }
  }

  // Init VaultManager
  manager = new VaultManager({
    globalPath,
    workspacePath: workspaceVaultExists ? workspacePath : undefined,
  });
  await manager.init();

  contextGen = new ContextGenerator(manager);
  sessionTracker = new SessionTracker(manager);
  sessionTracker.activate();
  ctx.subscriptions.push(sessionTracker);

  // Tree views
  const vaultTree = new VaultTreeProvider(manager);
  const taskTree = new TaskTreeProvider(manager);
  const sessionTree = new SessionTreeProvider(manager);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbvault.vault', vaultTree),
    vscode.window.registerTreeDataProvider('kbvault.tasks', taskTree),
    vscode.window.registerTreeDataProvider('kbvault.sessions', sessionTree),
  );

  const refreshAll = () => {
    vaultTree.refresh();
    taskTree.refresh();
    sessionTree.refresh();
  };

  // --- Helper: resolve scope for new items ---
  async function pickScope(defaultScope: VaultScope): Promise<{ scope: VaultScope; rootDir: string } | undefined> {
    // If no workspace vault, always global
    if (!manager.workspaceStore) {
      return { scope: 'global', rootDir: manager.globalPath };
    }

    // Offer choice
    const items = [
      { label: '🌐 Global', description: 'Available in all workspaces', value: 'global' as VaultScope },
      { label: '📁 Workspace', description: 'Only for this project', value: 'workspace' as VaultScope },
    ];

    // Put default first
    if (defaultScope === 'workspace') items.reverse();

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Where should this be saved?',
    });
    if (!picked) return undefined;

    const rootDir = manager.rootDirFor(picked.value);
    if (!rootDir) return undefined;
    return { scope: picked.value, rootDir };
  }

  // --- Commands ---
  ctx.subscriptions.push(
    // Refresh
    vscode.commands.registerCommand('kbvault.refresh', refreshAll),

    // Open / change global vault
    vscode.commands.registerCommand('kbvault.openVault', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select Global Vault Folder',
      });
      if (!uris?.[0]) return;

      const newPath = uris[0].fsPath;
      await config.update('globalPath', newPath, vscode.ConfigurationTarget.Global);

      // Reinitialize manager with new global path
      manager = new VaultManager({
        globalPath: newPath,
        workspacePath: manager.workspacePath,
      });
      await manager.init();
      contextGen = new ContextGenerator(manager);

      refreshAll();
      vscode.window.showInformationMessage(`Global vault set to: ${newPath}`);
    }),

    // Init workspace vault
    vscode.commands.registerCommand('kbvault.initWorkspace', async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      if (manager.workspaceStore) {
        vscode.window.showInformationMessage('Workspace vault already exists.');
        return;
      }

      const wPath = path.join(workspaceFolder.uri.fsPath, '.kbvault');
      await manager.initWorkspace(wPath);
      refreshAll();
      vscode.window.showInformationMessage(`Workspace vault created at: ${wPath}`);
    }),

    // New Note
    vscode.commands.registerCommand('kbvault.newNote', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Note title',
        placeHolder: 'My new note',
      });
      if (!title) return;

      const defaultScope = config.get<string>('newNoteDefaultScope') === 'workspace' ? 'workspace' : 'global';
      const target = await pickScope(defaultScope as VaultScope);
      if (!target) return;

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = path.join(target.rootDir, 'reference', `${slug}.md`);

      await manager.writeNote(filePath, {
        title,
        type: 'note',
        created: new Date().toISOString(),
        tags: [],
      }, `\n# ${title}\n\n`);

      await sessionTracker.log({ action: 'create', file: filePath });
      refreshAll();

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    // New Task
    vscode.commands.registerCommand('kbvault.newTask', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Task description',
        placeHolder: 'What needs to be done?',
      });
      if (!title) return;

      const contexts = config.get<string[]>('gtd.contexts') ?? [];
      const selectedContexts = await vscode.window.showQuickPick(contexts, {
        canPickMany: true,
        placeHolder: 'Select GTD contexts (optional)',
      });

      const project = await vscode.window.showInputBox({
        prompt: 'Project (optional)',
        placeHolder: 'Leave empty for no project',
      });

      // Default tasks to workspace if workspace vault exists
      const defaultScope = config.get<string>('newTaskDefaultScope') === 'global' ? 'global' : 'workspace';
      const target = await pickScope(defaultScope as VaultScope);
      if (!target) return;

      // If workspace vault doesn't exist and user picked workspace, create it
      if (target.scope === 'workspace' && !manager.workspaceStore && workspaceFolder) {
        await manager.initWorkspace(path.join(workspaceFolder.uri.fsPath, '.kbvault'));
      }

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = path.join(target.rootDir, 'inbox', `${slug}.md`);

      await manager.writeNote(filePath, {
        title,
        type: 'task',
        status: 'inbox',
        context: selectedContexts ?? [],
        project: project || undefined,
        created: new Date().toISOString(),
        priority: 'medium',
      }, `\n${title}\n\n## Notes\n\n`);

      await sessionTracker.log({ action: 'create', file: filePath });
      refreshAll();

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    // Set Task Status (full picker)
    vscode.commands.registerCommand('kbvault.setTaskStatus', async () => {
      const editor = vscode.window.activeTextEditor;
      let filePath: string | undefined;

      if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
        filePath = editor.document.uri.fsPath;
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Open a vault task file first.');
        return;
      }

      const note = await manager.readNote(filePath);
      const currentStatus = note.frontmatter.status ?? 'inbox';

      const statuses = Object.entries(GTD_LISTS).map(([key, label]) => ({
        label: currentStatus === key ? `${label} (current)` : label,
        value: key as TaskStatus,
      }));

      const picked = await vscode.window.showQuickPick(statuses, {
        placeHolder: `Current: ${GTD_LISTS[currentStatus as TaskStatus] ?? currentStatus}`,
      });
      if (!picked) return;

      note.frontmatter.status = picked.value;
      await manager.writeNote(filePath, note.frontmatter, note.body);

      await sessionTracker.log({
        action: 'status_change',
        file: filePath,
        detail: `${currentStatus} → ${picked.value}`,
      });

      refreshAll();
      vscode.window.showInformationMessage(`Task moved to: ${GTD_LISTS[picked.value]}`);
    }),

    // Mark Done (quick checkbox action)
    vscode.commands.registerCommand('kbvault.markDone', async () => {
      const editor = vscode.window.activeTextEditor;
      let filePath: string | undefined;

      if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
        filePath = editor.document.uri.fsPath;
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Open a vault task file first.');
        return;
      }

      const note = await manager.readNote(filePath);
      const previousStatus = note.frontmatter.status ?? 'inbox';

      note.frontmatter.status = 'done';
      await manager.writeNote(filePath, note.frontmatter, note.body);

      await sessionTracker.log({
        action: 'status_change',
        file: filePath,
        detail: `${previousStatus} → done`,
      });

      refreshAll();
      vscode.window.showInformationMessage('Task marked done ✓');
    }),

    // Delete Note
    vscode.commands.registerCommand('kbvault.deleteNote', async () => {
      const editor = vscode.window.activeTextEditor;
      let filePath: string | undefined;

      if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
        filePath = editor.document.uri.fsPath;
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Open a vault file first.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete ${path.basename(filePath)}?`,
        { modal: true },
        'Delete'
      );

      if (confirm === 'Delete') {
        await manager.delete(filePath);
        refreshAll();
        vscode.window.showInformationMessage('Note deleted.');
      }
    }),

    // Compile Context
    vscode.commands.registerCommand('kbvault.compileContext', async () => {
      const allFiles = await manager.queryNotes({});
      const items = allFiles.map(n => ({
        label: n.frontmatter.title ?? n.relativePath,
        description: [
          n.source === 'workspace' ? '📁' : '🌐',
          n.frontmatter.type,
          n.frontmatter.status,
        ].filter(Boolean).join(' | '),
        detail: n.relativePath,
        path: n.path,
        picked: n.frontmatter.status === 'active' || n.frontmatter.status === 'next',
      }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select notes to include in AI context',
      });
      if (!selected?.length) return;

      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', value: 'markdown' as const },
          { label: 'XML (for Claude)', value: 'xml' as const },
        ],
        { placeHolder: 'Output format' }
      );
      if (!format) return;

      const compiled = await contextGen.compileContext(
        selected.map(s => s.path),
        { format: format.value }
      );

      const doc = await vscode.workspace.openTextDocument({
        content: compiled,
        language: format.value === 'xml' ? 'xml' : 'markdown',
      });
      await vscode.window.showTextDocument(doc);

      await sessionTracker.log({
        action: 'context_compile',
        detail: `${selected.length} notes, ${format.label} format`,
      });

      vscode.window.showInformationMessage(
        `Context compiled: ${selected.length} notes. Copy to your AI tool.`
      );
    }),

    // Generate CLAUDE.md
    vscode.commands.registerCommand('kbvault.generateClaudeMd', async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const content = await contextGen.generateClaudeMd(workspaceFolder.uri.fsPath);
      const targetPath = path.join(workspaceFolder.uri.fsPath, 'CLAUDE.md');

      const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);

      const action = await vscode.window.showInformationMessage(
        `Write to ${targetPath}?`,
        'Write', 'Cancel'
      );

      if (action === 'Write') {
        const uri = vscode.Uri.file(targetPath);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage('CLAUDE.md written.');
      }
    }),

    // Generate Copilot Instructions
    vscode.commands.registerCommand('kbvault.generateCopilotInstructions', async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const content = await contextGen.generateCopilotInstructions();
      const targetDir = path.join(workspaceFolder.uri.fsPath, '.github');
      const targetPath = path.join(targetDir, 'copilot-instructions.md');

      const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);

      const action = await vscode.window.showInformationMessage(
        `Write to ${targetPath}?`,
        'Write', 'Cancel'
      );

      if (action === 'Write') {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(targetPath),
          Buffer.from(content, 'utf-8')
        );
        vscode.window.showInformationMessage('copilot-instructions.md written.');
      }
    }),

    // Log Activity
    vscode.commands.registerCommand('kbvault.logActivity', async () => {
      const detail = await vscode.window.showInputBox({
        prompt: 'What did you just do / decide / learn?',
        placeHolder: 'e.g., Decided to use Redis for caching instead of Memcached',
      });
      if (!detail) return;

      const editor = vscode.window.activeTextEditor;
      const relatedFile = editor?.document.uri.fsPath;

      await sessionTracker.log({
        action: 'activity_log',
        file: relatedFile,
        detail,
      });

      sessionTree.refresh();
      vscode.window.showInformationMessage('Activity logged.');
    }),
  );

  // --- Staleness check on activation ---
  if (config.get<boolean>('autoDetectStaleness') && workspaceFolder) {
    const staleResults = await checkStaleness(manager, workspaceFolder.uri.fsPath);
    const staleFiles = staleResults.filter(r => r.isStale);

    if (staleFiles.length > 0) {
      const fileNames = staleFiles.map(r => r.file).join(', ');
      const missing = staleFiles.filter(r => r.aiFileMtime === null);
      const outdated = staleFiles.filter(r => r.aiFileMtime !== null);

      let message = 'KB Vault: ';
      if (missing.length > 0) {
        message += `${missing.map(r => r.file).join(', ')} can be generated from vault content. `;
      }
      if (outdated.length > 0) {
        message += `${outdated.map(r => r.file).join(', ')} may be outdated.`;
      }

      const action = await vscode.window.showInformationMessage(
        message.trim(),
        'Regenerate CLAUDE.md',
        'Regenerate Copilot',
        'Dismiss'
      );

      if (action === 'Regenerate CLAUDE.md') {
        await vscode.commands.executeCommand('kbvault.generateClaudeMd');
      } else if (action === 'Regenerate Copilot') {
        await vscode.commands.executeCommand('kbvault.generateCopilotInstructions');
      }
    }
  }

  vscode.window.showInformationMessage(`KB Vault active: ${globalPath}`);
}

export function deactivate() {}
```

- [ ] **Step 2: Update package.json to include kbvault.initWorkspace command**

Add to the commands array:

```json
{ "command": "kbvault.initWorkspace", "title": "KB Vault: Initialize Workspace Vault" }
```

- [ ] **Step 3: Compile the full project**

Run: `cd /Users/lwbailey/projects/docs/knowledge-ext && npx tsc -p ./ 2>&1`

Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: rewrite extension with VaultManager, kbvault namespace, staleness detection"
```

---

## Chunk 4: Compile, Test, and Verify

### Task 12: Full compilation and smoke test

**Files:**
- All files

- [ ] **Step 1: Clean and recompile**

```bash
cd /Users/lwbailey/projects/docs/knowledge-ext
rm -rf out/
npx tsc -p ./
```

Expected: Clean compilation, JavaScript output in `out/`.

- [ ] **Step 2: Verify compiled output exists**

```bash
ls -la out/
ls -la out/vault/
ls -la out/views/
ls -la out/context/
ls -la out/session/
```

Expected: All .js files present: extension.js, vault/manager.js, vault/store.js, vault/types.js, vault/staleness.js, views/*.js, context/generator.js, session/tracker.js

- [ ] **Step 3: Check for remaining `knowledgeVault` references (should be zero)**

```bash
grep -r "knowledgeVault" src/ package.json --include="*.ts" --include="*.json"
```

Expected: No matches. All references should now be `kbvault`.

- [ ] **Step 4: Check for remaining `Knowledge Vault` references (should be gone except comments)**

```bash
grep -r "Knowledge Vault" src/ package.json --include="*.ts" --include="*.json"
```

Expected: No matches in package.json. Any matches in .ts files should only be in comments if at all.

- [ ] **Step 5: Commit final state**

```bash
git add -A
git commit -m "chore: clean build, verify full kbvault namespace migration"
```

---

### Task 13: Update launch.json and tasks.json

**Files:**
- Modify: `.vscode/launch.json`
- Modify: `.vscode/tasks.json`

- [ ] **Step 1: Verify launch.json is correct for the extension**

Read `.vscode/launch.json` and ensure it has:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run KB Vault Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}"
      ],
      "outFiles": [
        "${workspaceFolder}/out/**/*.js"
      ],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

- [ ] **Step 2: Verify tasks.json has compile task**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "compile",
      "problemMatcher": ["$tsc"],
      "group": {
        "kind": "build",
        "isDefault": true
      },
      "label": "npm: compile"
    },
    {
      "type": "npm",
      "script": "watch",
      "problemMatcher": ["$tsc-watch"],
      "isBackground": true,
      "group": "build",
      "label": "npm: watch"
    }
  ]
}
```

- [ ] **Step 3: Commit if changed**

```bash
git add .vscode/
git commit -m "chore: update launch and task configs for KB Vault"
```

---

### Task 14: Update .gitignore for workspace vaults

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Read current .gitignore**

Read the file to see current contents.

- [ ] **Step 2: Ensure these entries exist**

```
node_modules/
out/
.kbvault/
*.vsix
```

The `.kbvault/` entry ensures workspace vaults in projects that use this extension are not accidentally committed. Users can override in their project .gitignore.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add .kbvault to gitignore"
```

---

## Summary

### What this plan delivers:

1. **`kbvault` namespace** — clean, collision-free prefix for all commands, views, and config
2. **Multi-root vault** — global (`~/.kbvault/`) always active, workspace (`.kbvault/`) on demand
3. **VaultManager** — merges both stores, workspace wins on duplicates, scope tracking on every file
4. **Scope indicators** — 🌐 globe for global items, 📁 folder for workspace items in all views
5. **Checkbox-style task completion** — `kbvault.markDone` for quick completion, full status picker via `kbvault.setTaskStatus`
6. **Delete support** — `kbvault.deleteNote` with confirmation dialog
7. **Init workspace vault** — `kbvault.initWorkspace` creates `.kbvault/` on demand
8. **Staleness detection** — auto-checks CLAUDE.md and copilot-instructions.md on workspace open, offers to regenerate
9. **Scope-aware new item creation** — prompts for Global vs Workspace with configurable defaults

### What's NOT in this plan (future work):

- Full-text search across vault
- Keyboard shortcuts / keybindings
- Webview panels (Kanban board, context preview)
- Wikilink support (`[[note]]` syntax)
- Sync / shared vaults / team features
- Unit tests (should be a separate plan)
- Marketplace publishing
- Profile bundles (named context sets)
