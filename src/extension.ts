import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { VaultManager } from './vault/manager';
import { TaskStatus, GTD_LISTS, VaultScope, ParsedNote } from './vault/types';
import { ContextGenerator } from './context/generator';
import { SessionTracker } from './session/tracker';
import { VaultTreeProvider, VaultFilter } from './views/vault-tree';
import { TaskTreeProvider, TaskItem, TaskFilter } from './views/task-tree';
import { SessionTreeProvider } from './views/session-tree';
import { checkStaleness } from './vault/staleness';
import { EditorPanelManager } from './views/editor-panel';
import { BriefingPanelManager } from './views/briefing-panel';
import { pickNoteCreationMethod, pickTaskCreationMethod } from './note-creation';
import { WeeklyReviewPanelManager } from './weekly-review';
import { GroundworkDB } from './db/index';
import { initSchema } from './db/schema';
import { reindex, VaultSource, frontmatterToRow } from './db/sync';
import { upsertNote as dbUpsertNote, deleteNote as dbDeleteNote } from './db/queries';
import { parseFrontmatter } from './vault/store';
import * as crypto from 'crypto';

let manager: VaultManager;
let db: GroundworkDB;
let contextGen: ContextGenerator;
let sessionTracker: SessionTracker;
let editorPanels: EditorPanelManager;
let briefingPanel: BriefingPanelManager;
let weeklyReviewPanel: WeeklyReviewPanelManager;

export async function activate(ctx: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('groundwork');

  // Resolve global vault path
  const configuredGlobal = config.get<string>('globalPath');
  const globalPath = configuredGlobal || path.join(os.homedir(), '.groundwork');

  // Resolve workspace vault path
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceVaultPath = workspaceFolder
    ? path.join(workspaceFolder.uri.fsPath, '.groundwork')
    : undefined;

  // Check if workspace vault exists (don't create it automatically)
  let workspaceVaultExists = false;
  if (workspaceVaultPath) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(workspaceVaultPath));
      workspaceVaultExists = stat.type === vscode.FileType.Directory;
    } catch {
      // Doesn't exist yet — that's fine
    }
  }

  // Init VaultManager
  manager = new VaultManager({
    globalPath,
    workspacePath: workspaceVaultExists ? workspaceVaultPath : undefined,
  });
  await manager.init();

  // Initialize SQLite index
  const dbPath = path.join(globalPath, '.index.db');
  db = new GroundworkDB(dbPath);
  await db.open();
  initSchema(db);

  // Startup reindex — sync vault files into DB
  const vaultSources: VaultSource[] = [{ rootDir: globalPath, scope: 'global' }];
  if (manager.workspacePath) {
    vaultSources.push({ rootDir: manager.workspacePath, scope: 'workspace' });
  }
  await reindex(db, vaultSources);
  db.saveToDisk();

  // Wire write-through: file writes → DB updates
  const wireWriteThrough = (store: import('./vault/store').VaultStore) => {
    store.onWrite = (filePath, frontmatter, body) => {
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      const row = frontmatterToRow(frontmatter, filePath, store.scope, bodyHash);
      dbUpsertNote(db, row, body);
      debouncedSave();
    };
    store.onDelete = (filePath) => {
      dbDeleteNote(db, filePath);
      debouncedSave();
    };
  };
  wireWriteThrough(manager.globalStore);
  if (manager.workspaceStore) wireWriteThrough(manager.workspaceStore);

  // Debounced DB save — flush at most every 500ms
  let saveTimer: NodeJS.Timeout | undefined;
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { db.saveToDisk(); } catch { /* shutting down */ } }, 500);
  };

  // File watcher — sync external edits to DB
  const watchPatterns = [
    new vscode.RelativePattern(globalPath, '**/*.md'),
    ...(manager.workspacePath
      ? [new vscode.RelativePattern(manager.workspacePath, '**/*.md')]
      : []),
  ];
  for (const pattern of watchPatterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const syncFile = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (filePath.includes('.sessions')) return;
      const scope = (manager.workspacePath && filePath.startsWith(manager.workspacePath))
        ? 'workspace' as const : 'global' as const;
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
        const row = frontmatterToRow(frontmatter, filePath, scope, bodyHash);
        dbUpsertNote(db, row, body);
        debouncedSave();
      } catch { /* file may have been deleted between events */ }
    };

    watcher.onDidCreate(syncFile);
    watcher.onDidChange(syncFile);
    watcher.onDidDelete(uri => {
      dbDeleteNote(db, uri.fsPath);
      debouncedSave();
    });
    ctx.subscriptions.push(watcher);
  }

  contextGen = new ContextGenerator(manager, db);
  sessionTracker = new SessionTracker(manager);
  sessionTracker.activate();
  ctx.subscriptions.push(sessionTracker);

  // Output channel — declared early so commands can log to it
  const out = vscode.window.createOutputChannel('Groundwork');
  out.appendLine(`[Groundwork] Activated at: ${new Date().toISOString()}`);
  out.appendLine(`[Groundwork] Global vault: ${globalPath}`);
  if (manager.workspacePath) out.appendLine(`[Groundwork] Workspace vault: ${manager.workspacePath}`);

  // Set context key so Init Workspace button hides when vault already exists
  vscode.commands.executeCommand('setContext', 'groundwork.hasWorkspaceVault', !!manager.workspaceStore);

  // Tree views
  const vaultTree = new VaultTreeProvider(manager);
  const taskTree = new TaskTreeProvider(manager, db);
  const sessionTree = new SessionTreeProvider(manager);

  const refreshAll = () => {
    vaultTree.refresh();
    taskTree.refresh();
    sessionTree.refresh();
  };

  editorPanels = new EditorPanelManager(manager, ctx.extensionUri, refreshAll, initWorkspaceVault);
  briefingPanel = new BriefingPanelManager(manager, ctx.extensionUri, refreshAll, db);
  weeklyReviewPanel = new WeeklyReviewPanelManager(manager, ctx.extensionUri, refreshAll);

  // Tasks tree view — createTreeView (not registerTreeDataProvider) for drag-and-drop support
  const tasksView = vscode.window.createTreeView('groundwork.tasks', {
    treeDataProvider: taskTree,
    dragAndDropController: taskTree,
    showCollapseAll: false,
  });

  // When a task is moved via drag-and-drop, log the session event and update any open editor panel
  taskTree.onTaskDropped = async (filePath: string, detail: string) => {
    await sessionTracker.log({ action: 'status_change', file: filePath, detail });
    const newStatus = detail.split(' → ')[1];
    if (newStatus) editorPanels.notifyStatusChange(filePath, newStatus);
  };

  // Vault tree view — createTreeView for drag-and-drop support
  const vaultView = vscode.window.createTreeView('groundwork.vault', {
    treeDataProvider: vaultTree,
    dragAndDropController: vaultTree,
    showCollapseAll: false,
  });

  // When a vault file is moved via drag-and-drop, log + reopen editor at new path
  vaultTree.onFileMoved = async (oldPath: string, newPath: string, detail: string) => {
    await sessionTracker.log({ action: 'status_change', file: oldPath, detail });
    await editorPanels.handleFileMove(oldPath, newPath);
  };

  ctx.subscriptions.push(
    tasksView,
    vaultView,
    vscode.window.registerTreeDataProvider('groundwork.sessions', sessionTree),
  );

  // --- Helper: move a note between global and workspace vaults ---
  async function moveNote(note: ParsedNote, targetScope: VaultScope) {
    let targetRoot = manager.rootDirFor(targetScope);

    // If moving to workspace and no workspace vault exists yet, offer to create it
    if (!targetRoot && targetScope === 'workspace') {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first, then initialize a workspace vault.');
        return;
      }
      const answer = await vscode.window.showInformationMessage(
        'No workspace vault exists yet. Create one and move this task into it?',
        'Create & Move', 'Cancel'
      );
      if (answer !== 'Create & Move') return;

      const wPath = path.join(workspaceFolder.uri.fsPath, '.groundwork');
      await initWorkspaceVault(wPath);
      targetRoot = wPath;
      refreshAll(); // show new workspace root in vault tree
    }

    if (!targetRoot) {
      vscode.window.showWarningMessage('No global vault configured.');
      return;
    }

    const sourceRoot = manager.rootDirFor(note.source);
    if (!sourceRoot) return;

    const relPath = path.relative(sourceRoot, note.path);
    const targetPath = path.join(targetRoot, relPath);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetPath)));
    await manager.writeNote(targetPath, note.frontmatter, note.body);
    await manager.delete(note.path);

    refreshAll();
    vscode.window.showInformationMessage(`Moved to ${targetScope} vault.`);
  }

  // --- Helper: resolve scope for new items ---
  async function pickScope(defaultScope: VaultScope): Promise<{ scope: VaultScope; rootDir: string } | undefined> {
    // If no workspace folder is open, always global (no workspace option possible)
    if (!workspaceFolder) {
      return { scope: 'global', rootDir: manager.globalPath };
    }

    const items = [
      { label: '🌐 Global', description: 'Available in all workspaces', value: 'global' as VaultScope },
      { label: '📁 Workspace', description: manager.workspaceStore ? 'Only for this project' : 'Creates .groundwork in this project', value: 'workspace' as VaultScope },
    ];

    // Put default first
    if (defaultScope === 'workspace') items.reverse();

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Where should this be saved?',
    });
    if (!picked) return undefined;

    if (picked.value === 'workspace') {
      // Create workspace vault on demand if it doesn't exist
      if (!manager.workspaceStore) {
        const wPath = path.join(workspaceFolder.uri.fsPath, '.groundwork');
        await initWorkspaceVault(wPath);
        refreshAll();
      }
      const rootDir = manager.rootDirFor('workspace');
      if (!rootDir) return undefined;
      return { scope: 'workspace', rootDir };
    }

    return { scope: 'global', rootDir: manager.globalPath };
  }

  // --- Helper: offer to add .groundwork/ to .gitignore ---
  async function promptGitignore(workspaceRoot: string) {
    const gitDir = path.join(workspaceRoot, '.git');
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(gitDir));
      if (stat.type !== vscode.FileType.Directory) return;
    } catch {
      return; // no .git directory — not a git repo
    }

    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    let content = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
      content = Buffer.from(bytes).toString('utf8');
    } catch {
      // .gitignore doesn't exist yet — that's fine
    }

    // Check if .groundwork is already ignored
    const lines = content.split('\n').map(l => l.trim());
    if (lines.some(l => l === '.groundwork' || l === '.groundwork/' || l === '/.groundwork' || l === '/.groundwork/')) {
      return; // already gitignored
    }

    const answer = await vscode.window.showInformationMessage(
      'Add .groundwork/ to .gitignore? This keeps your workspace vault out of version control.',
      'Add to .gitignore', 'Skip'
    );
    if (answer !== 'Add to .gitignore') return;

    const newLine = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const entry = `${newLine}.groundwork/\n`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(gitignorePath),
      Buffer.from(content + entry, 'utf8')
    );
    vscode.window.showInformationMessage('.groundwork/ added to .gitignore');
  }

  // --- Helper: init workspace vault + prompt gitignore ---
  async function initWorkspaceVault(wPath: string) {
    await manager.initWorkspace(wPath);
    // Reindex new workspace vault into DB and wire write-through
    if (manager.workspaceStore) {
      await reindex(db, [{ rootDir: manager.workspacePath!, scope: 'workspace' }]);
      db.saveToDisk();
      wireWriteThrough(manager.workspaceStore);
    }
    if (workspaceFolder) {
      promptGitignore(workspaceFolder.uri.fsPath).catch(() => {}); // fire-and-forget
    }
  }

  // --- Commands ---
  ctx.subscriptions.push(
    // Open in WYSIWYG editor
    vscode.commands.registerCommand('groundwork.openEditor', async (uri?: vscode.Uri) => {
      const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath || !manager.isVaultFile(filePath)) {
        vscode.window.showWarningMessage('Select a vault file to open.');
        return;
      }
      await editorPanels.openFile(filePath);
    }),

    // Refresh
    vscode.commands.registerCommand('groundwork.refresh', refreshAll),

    // Filter Tasks — unified entry point: pick a filter dimension, then a value
    vscode.commands.registerCommand('groundwork.filterByTag', async () => {
      await showFilterPicker(taskTree, tasksView);
    }),

    // Search Tasks — full-text search across titles and body content
    vscode.commands.registerCommand('groundwork.searchTasks', async () => {
      const current = taskTree.filter.search;
      const query = await vscode.window.showInputBox({
        prompt: 'Search tasks (title, body, tags, project)',
        placeHolder: 'Type to search…',
        value: current ?? '',
      });
      if (query === undefined) return; // cancelled
      if (query === '') {
        taskTree.updateFilter('search', undefined);
      } else {
        taskTree.updateFilter('search', query);
      }
      syncFilterContext(taskTree);
      updateViewMessage(taskTree, tasksView);
    }),

    // Clear All Filters
    vscode.commands.registerCommand('groundwork.clearTagFilter', () => {
      taskTree.clearFilter();
      syncFilterContext(taskTree);
      updateViewMessage(taskTree, tasksView);
    }),

    // Open / change global vault
    vscode.commands.registerCommand('groundwork.openVault', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select Global Vault Folder',
      });
      if (!uris?.[0]) return;

      const newPath = uris[0].fsPath;
      await config.update('globalPath', newPath, vscode.ConfigurationTarget.Global);

      manager = new VaultManager({
        globalPath: newPath,
        workspacePath: manager.workspacePath,
      });
      await manager.init();
      contextGen = new ContextGenerator(manager, db);

      refreshAll();
      vscode.window.showInformationMessage(`Global vault set to: ${newPath}`);
    }),

    // Init workspace vault
    vscode.commands.registerCommand('groundwork.initWorkspace', async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      if (manager.workspaceStore) {
        vscode.window.showInformationMessage('Workspace vault already exists.');
        return;
      }

      const wPath = path.join(workspaceFolder.uri.fsPath, '.groundwork');
      await initWorkspaceVault(wPath);
      vscode.commands.executeCommand('setContext', 'groundwork.hasWorkspaceVault', true);
      refreshAll();
      vscode.window.showInformationMessage(`Workspace vault created at: ${wPath}`);
    }),

    // New Note — blank, from template, or AI-generated
    vscode.commands.registerCommand('groundwork.newNote', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Note title',
        placeHolder: 'My new note',
      });
      if (!title) return;

      const creation = await pickNoteCreationMethod(
        title,
        () => contextGen.compileActiveContext()
      );
      if (!creation) return;

      const defaultScope = config.get<string>('newNoteDefaultScope') === 'workspace' ? 'workspace' : 'global';
      const target = await pickScope(defaultScope as VaultScope);
      if (!target) return;

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const store = manager.storeFor(target.scope) ?? manager.globalStore;
      // Route to folder based on note type
      const folder = creation.noteType === 'project' ? 'projects'
        : creation.noteType === 'reference' ? 'reference'
        : 'notes';
      const filePath = await store.findAvailablePath(path.join(target.rootDir, folder), slug);

      await manager.writeNote(filePath, {
        title,
        type: creation.noteType,
        created: new Date().toISOString(),
        tags: [],
      }, creation.body);

      await sessionTracker.log({ action: 'create', file: filePath });
      refreshAll();
      await editorPanels.openFile(filePath);
    }),

    // New Note in a specific vault folder (from right-click on folder in vault tree)
    vscode.commands.registerCommand('groundwork.newNoteHere', async (folderItem?: { path: string; source: VaultScope }) => {
      if (!folderItem) return;

      const title = await vscode.window.showInputBox({
        prompt: 'Note title',
        placeHolder: 'My new note',
      });
      if (!title) return;

      const creation = await pickNoteCreationMethod(
        title,
        () => contextGen.compileActiveContext()
      );
      if (!creation) return;

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const store = manager.storeFor(folderItem.source) ?? manager.globalStore;
      const filePath = await store.findAvailablePath(folderItem.path, slug);

      await manager.writeNote(filePath, {
        title,
        type: creation.noteType,
        created: new Date().toISOString(),
        tags: [],
      }, creation.body);

      await sessionTracker.log({ action: 'create', file: filePath });
      refreshAll();
      await editorPanels.openFile(filePath);
    }),

    // New Task
    vscode.commands.registerCommand('groundwork.newTask', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Task description',
        placeHolder: 'What needs to be done?',
      });
      if (!title) return;

      const creation = await pickTaskCreationMethod(
        title,
        () => contextGen.compileActiveContext()
      );
      if (!creation) return;

      const contexts = config.get<string[]>('gtd.contexts') ?? [];
      const selectedContexts = await vscode.window.showQuickPick(contexts, {
        canPickMany: true,
        placeHolder: 'Select GTD contexts (optional)',
      });

      const project = await vscode.window.showInputBox({
        prompt: 'Project (optional)',
        placeHolder: 'Leave empty for no project',
      });

      const defaultScope = config.get<string>('newTaskDefaultScope') === 'global' ? 'global' : 'workspace';
      const target = await pickScope(defaultScope as VaultScope);
      if (!target) return;

      // If workspace vault doesn't exist and user picked workspace, create it
      if (target.scope === 'workspace' && !manager.workspaceStore && workspaceFolder) {
        await initWorkspaceVault(path.join(workspaceFolder.uri.fsPath, '.groundwork'));
      }

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const store = manager.storeFor(target.scope) ?? manager.globalStore;
      const filePath = await store.findAvailablePath(path.join(target.rootDir, 'inbox'), slug);

      await manager.writeNote(filePath, {
        title,
        type: 'task',
        status: 'inbox',
        context: selectedContexts ?? [],
        project: project || undefined,
        created: new Date().toISOString(),
        priority: 'medium',
      }, creation.body);

      await sessionTracker.log({ action: 'create', file: filePath });
      refreshAll();
      await editorPanels.openFile(filePath);
    }),

    // Set Task Status (full status picker) — accepts tree item from context menu or falls back to active editor
    vscode.commands.registerCommand('groundwork.setTaskStatus', async (item?: TaskItem) => {
      let filePath: string | undefined = item?.note.path;

      if (!filePath) {
        const editor = vscode.window.activeTextEditor;
        if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
          filePath = editor.document.uri.fsPath;
        }
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Select a task first.');
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

    // Mark Done — accepts tree item from context menu or falls back to active editor
    vscode.commands.registerCommand('groundwork.markDone', async (item?: TaskItem) => {
      let filePath: string | undefined = item?.note.path;

      if (!filePath) {
        const editor = vscode.window.activeTextEditor;
        if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
          filePath = editor.document.uri.fsPath;
        }
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Select a task first.');
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

    // Delete Note — accepts TaskItem (task tree) or VaultFile (vault tree) or falls back to active editor
    vscode.commands.registerCommand('groundwork.deleteNote', async (item?: TaskItem | { path: string; name: string }) => {
      let filePath: string | undefined;
      let displayName: string | undefined;

      if (item && 'kind' in item && item.kind === 'item') {
        filePath = item.note.path;
        displayName = item.note.frontmatter.title ?? path.basename(filePath);
      } else if (item && 'path' in item) {
        // VaultFile from vault tree
        filePath = item.path;
        displayName = item.name ?? path.basename(filePath);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor && manager.isVaultFile(editor.document.uri.fsPath)) {
          filePath = editor.document.uri.fsPath;
          displayName = path.basename(filePath);
        }
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Select a file to delete.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete "${displayName}"?`,
        { modal: true },
        'Delete'
      );

      if (confirm === 'Delete') {
        await manager.delete(filePath);
        refreshAll();
        vscode.window.showInformationMessage('File deleted.');
      }
    }),

    // Move to global vault — works for both tasks and vault files
    vscode.commands.registerCommand('groundwork.moveToGlobal', async (item?: any) => {
      const note = await resolveNote(item);
      if (!note) { vscode.window.showWarningMessage('Select an item first.'); return; }
      await moveNote(note, 'global');
    }),

    // Move to workspace vault — works for both tasks and vault files
    vscode.commands.registerCommand('groundwork.moveToWorkspace', async (item?: any) => {
      const note = await resolveNote(item);
      if (!note) { vscode.window.showWarningMessage('Select an item first.'); return; }
      await moveNote(note, 'workspace');
    }),

    // Rename — works for both tasks and vault files (right-click or F2)
    vscode.commands.registerCommand('groundwork.renameNote', async (item?: any) => {
      const note = await resolveNote(item);
      if (!note) { vscode.window.showWarningMessage('Select a file to rename.'); return; }

      const oldTitle = note.frontmatter.title ?? path.basename(note.path, '.md');
      const newTitle = await vscode.window.showInputBox({
        prompt: 'Rename',
        value: oldTitle,
        validateInput: (v) => v.trim() ? null : 'Title cannot be empty',
      });
      if (!newTitle || newTitle === oldTitle) return;

      const oldSlug = path.basename(note.path, '.md');
      const newSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const dir = path.dirname(note.path);

      // Update frontmatter
      note.frontmatter.title = newTitle;
      note.frontmatter.modified = new Date().toISOString();

      if (newSlug === oldSlug) {
        // Same slug — just update frontmatter in place
        await manager.writeNote(note.path, note.frontmatter, note.body);
      } else {
        // Different slug — write to new path, delete old
        const store = manager.storeFor(note.source) ?? manager.globalStore;
        const newPath = await store.findAvailablePath(dir, newSlug);
        await manager.writeNote(newPath, note.frontmatter, note.body);
        await manager.delete(note.path);

        // Notify if collision caused a different filename
        const actualSlug = path.basename(newPath, '.md');
        if (actualSlug !== newSlug) {
          vscode.window.showInformationMessage(`Renamed to ${actualSlug}.md (name already existed)`);
        }

        await sessionTracker.log({
          action: 'rename' as any,
          file: newPath,
          detail: `${oldTitle} → ${newTitle}`,
        });
      }

      refreshAll();
    }),

    // Archive — move a vault file to archive/ (vault files only, not tasks)
    vscode.commands.registerCommand('groundwork.archiveNote', async (item?: any) => {
      const note = await resolveNote(item);
      if (!note) { vscode.window.showWarningMessage('Select a file to archive.'); return; }

      const store = manager.storeFor(note.source) ?? manager.globalStore;
      const archiveDir = path.join(store.rootDir, 'archive');
      await fs.promises.mkdir(archiveDir, { recursive: true });

      const fileName = path.basename(note.path);
      const newPath = await store.findAvailablePath(archiveDir, path.basename(fileName, '.md'));
      await store.rename(note.path, newPath);

      await sessionTracker.log({
        action: 'status_change' as any,
        file: newPath,
        detail: `archived`,
      });

      refreshAll();
      vscode.window.showInformationMessage(`Archived "${note.frontmatter.title ?? fileName}".`);
    }),

    // Unarchive — move an archived file back to notes/
    vscode.commands.registerCommand('groundwork.unarchiveNote', async (item?: any) => {
      const note = await resolveNote(item);
      if (!note) { vscode.window.showWarningMessage('Select a file to unarchive.'); return; }

      const store = manager.storeFor(note.source) ?? manager.globalStore;
      const notesDir = path.join(store.rootDir, 'notes');
      await fs.promises.mkdir(notesDir, { recursive: true });

      const fileName = path.basename(note.path);
      const newPath = await store.findAvailablePath(notesDir, path.basename(fileName, '.md'));
      await store.rename(note.path, newPath);

      await sessionTracker.log({
        action: 'status_change' as any,
        file: newPath,
        detail: `unarchived`,
      });

      refreshAll();
      vscode.window.showInformationMessage(`Unarchived "${note.frontmatter.title ?? fileName}" to notes/.`);
    }),

    // Quick Context — one click: copies Active + Next tasks to clipboard, ready to paste into any AI tool
    vscode.commands.registerCommand('groundwork.compileActiveContext', async () => {
      const compiled = await contextGen.compileActiveContext();
      await vscode.env.clipboard.writeText(compiled);

      const lineCount = compiled.split('\n').length;
      const taskCount = (compiled.match(/^- /mg) ?? []).length;

      await sessionTracker.log({
        action: 'context_compile',
        detail: `Quick context: ${taskCount} task(s), copied to clipboard`,
      });

      vscode.window.showInformationMessage(
        `Active context copied (${taskCount} task${taskCount !== 1 ? 's' : ''}, ~${lineCount} lines) — paste into your AI tool.`
      );
    }),

    // Compile Context for AI — manual multi-select with format choice
    vscode.commands.registerCommand('groundwork.compileContext', async () => {
      const allFiles = await manager.queryNotes({});
      const items = allFiles.map(n => ({
        label: n.frontmatter.title ?? n.relativePath,
        description: [
          n.source === 'workspace' ? '📂' : '🌐',
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

      // Open in editor tab for review
      const doc = await vscode.workspace.openTextDocument({
        content: compiled,
        language: format.value === 'xml' ? 'xml' : 'markdown',
      });
      await vscode.window.showTextDocument(doc);

      await sessionTracker.log({
        action: 'context_compile',
        detail: `${selected.length} notes, ${format.label} format`,
      });

      // Offer one-click copy from the notification
      const action = await vscode.window.showInformationMessage(
        `Context compiled: ${selected.length} note${selected.length !== 1 ? 's' : ''}. Ready to paste.`,
        'Copy to Clipboard'
      );
      if (action === 'Copy to Clipboard') {
        await vscode.env.clipboard.writeText(compiled);
        vscode.window.showInformationMessage('Copied to clipboard ✓');
      }
    }),

    // Generate CLAUDE.md (global)
    vscode.commands.registerCommand('groundwork.generateClaudeMd', async () => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const content = await contextGen.generateClaudeMd();

      // Write ~/.claude/CLAUDE.md
      const claudeDir = path.join(home, '.claude');
      const targetPath = path.join(claudeDir, 'CLAUDE.md');
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(claudeDir));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(content, 'utf-8'));

      // Write skill file to ~/.claude/skills/groundwork/SKILL.md
      const skillDir = path.join(claudeDir, 'skills', 'groundwork');
      const skillPath = path.join(skillDir, 'SKILL.md');
      const extSkillPath = path.join(ctx.extensionPath, 'resources', 'claude-skill.md');
      try {
        const skillContent = await vscode.workspace.fs.readFile(vscode.Uri.file(extSkillPath));
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(skillDir));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(skillPath), skillContent);
      } catch {
        // Skill file not bundled — skip silently
      }

      // Register Groundwork MCP server in ~/.claude/settings.json
      const claudeSettingsPath = path.join(claudeDir, 'settings.json');
      const serverScript = path.join(ctx.extensionPath, 'out', 'mcp', 'server.js');
      try {
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
        if (manager.workspacePath) { mcpArgs.push('--workspace-path', manager.workspacePath); }
        mcpServers['groundwork'] = { command: 'node', args: mcpArgs };
        settings.mcpServers = mcpServers;
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(claudeSettingsPath),
          Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf-8'),
        );
      } catch {
        // Non-fatal — MCP config is optional
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('~/.claude/CLAUDE.md, skill, and MCP server config written.');
    }),

    // Generate Copilot Instructions (global)
    vscode.commands.registerCommand('groundwork.generateCopilotInstructions', async () => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const content = await contextGen.generateCopilotInstructions();

      // Write instructions and skill to ~/.groundwork/
      const gwDir = path.join(home, '.groundwork');
      const targetPath = path.join(gwDir, 'copilot-instructions.md');
      const skillPath = path.join(gwDir, 'copilot-skill.md');

      await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(content, 'utf-8'));

      // Write skill file alongside
      const extSkillPath = path.join(ctx.extensionPath, 'resources', 'SKILL.md');
      try {
        const skillContent = await vscode.workspace.fs.readFile(vscode.Uri.file(extSkillPath));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(skillPath), skillContent);
      } catch {
        // Skill file not bundled — skip silently
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      await vscode.window.showTextDocument(doc);

      // Check if the VS Code setting already points to our file
      const copilotConfig = vscode.workspace.getConfiguration('github.copilot.chat.codeGeneration');
      const instructions = copilotConfig.get<unknown[]>('instructions') ?? [];
      const alreadyConfigured = instructions.some(
        (i: any) => i?.file && i.file.includes('copilot-instructions.md')
      );

      if (!alreadyConfigured) {
        const action = await vscode.window.showInformationMessage(
          'copilot-instructions.md written to ~/.groundwork/. Add to Copilot settings?',
          'Add Setting', 'Skip'
        );
        if (action === 'Add Setting') {
          const updated = [...instructions, { file: targetPath }];
          await copilotConfig.update('instructions', updated, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Copilot instructions setting updated.');
        }
      } else {
        vscode.window.showInformationMessage('copilot-instructions.md updated in ~/.groundwork/');
      }
    }),

    // Daily Briefing
    vscode.commands.registerCommand('groundwork.dailyBriefing', async () => {
      await briefingPanel.open();
    }),

    // Weekly Review — webview panel with full week overview and inline actions
    vscode.commands.registerCommand('groundwork.weeklyReview', async () => {
      await weeklyReviewPanel.open();
    }),

    // Filter Vault — unified multi-dimension filter (type, tag, search)
    vscode.commands.registerCommand('groundwork.filterVault', async () => {
      await showVaultFilterPicker(vaultTree, vaultView);
    }),

    // Search Vault — full-text search across vault notes
    vscode.commands.registerCommand('groundwork.searchVault', async () => {
      const current = vaultTree.filter.search;
      const query = await vscode.window.showInputBox({
        prompt: 'Search vault notes (title, body, tags, type)',
        placeHolder: 'Type to search…',
        value: current ?? '',
      });
      if (query === undefined) return; // cancelled
      vaultTree.updateFilter('search', query || undefined);
      syncVaultFilterContext(vaultTree);
      updateVaultViewMessage(vaultTree, vaultView);
    }),

    // Clear Vault Filters
    vscode.commands.registerCommand('groundwork.clearVaultFilter', () => {
      vaultTree.clearFilter();
      syncVaultFilterContext(vaultTree);
      updateVaultViewMessage(vaultTree, vaultView);
    }),

    // Collapse/Expand All — Tasks
    // Uses VS Code's real tree collapse (list.collapseAll) and reveal(expand) APIs
    // because TreeItemCollapsibleState in getTreeItem is only a hint for initial render.
    vscode.commands.registerCommand('groundwork.collapseAllTasks', async () => {
      await vscode.commands.executeCommand('groundwork.tasks.focus');
      await vscode.commands.executeCommand('list.collapseAll');
      vscode.commands.executeCommand('setContext', 'groundwork.tasksCollapsed', true);
    }),
    vscode.commands.registerCommand('groundwork.expandAllTasks', async () => {
      const groups = await taskTree.getChildren();
      for (const group of groups) {
        try { await tasksView.reveal(group, { expand: true }); } catch { /* skip */ }
      }
      vscode.commands.executeCommand('setContext', 'groundwork.tasksCollapsed', false);
    }),

    // Collapse/Expand All — Vault
    vscode.commands.registerCommand('groundwork.collapseAllVault', async () => {
      await vscode.commands.executeCommand('groundwork.vault.focus');
      await vscode.commands.executeCommand('list.collapseAll');
      vscode.commands.executeCommand('setContext', 'groundwork.vaultCollapsed', true);
    }),
    vscode.commands.registerCommand('groundwork.expandAllVault', async () => {
      const roots = await vaultTree.getChildren();
      for (const root of roots) {
        try { await vaultView.reveal(root, { expand: 2 }); } catch { /* skip */ }
      }
      vscode.commands.executeCommand('setContext', 'groundwork.vaultCollapsed', false);
    }),

    // Log Activity
    vscode.commands.registerCommand('groundwork.logActivity', async () => {
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

  // --- Status bar item — shows task counts, opens briefing on click ---
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'groundwork.dailyBriefing';
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  async function updateStatusBar() {
    try {
      const summary = await briefingPanel.getStatusSummary();
      const parts: string[] = ['$(calendar)'];
      if (summary.overdue > 0) parts.push(`${summary.overdue} overdue`);
      parts.push(`${summary.active} active`);
      if (summary.inbox > 0) parts.push(`${summary.inbox} inbox`);
      statusBar.text = parts.join(' · ');
      statusBar.tooltip = `Groundwork Daily Briefing\n${summary.active} active · ${summary.overdue} overdue · ${summary.inbox} inbox\nClick to open`;
      if (summary.overdue > 0) {
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBar.backgroundColor = undefined;
      }
    } catch {
      statusBar.text = '$(calendar) Groundwork';
      statusBar.tooltip = 'Groundwork Daily Briefing — click to open';
    }
  }

  // Update status bar now and whenever trees refresh
  updateStatusBar();
  const origRefreshAll = refreshAll;
  const refreshAllWithStatus = () => {
    origRefreshAll();
    updateStatusBar();
  };
  // Patch the refreshAll reference used by editor panels, briefing, and weekly review
  editorPanels = new EditorPanelManager(manager, ctx.extensionUri, refreshAllWithStatus, initWorkspaceVault);
  briefingPanel = new BriefingPanelManager(manager, ctx.extensionUri, refreshAllWithStatus);
  weeklyReviewPanel = new WeeklyReviewPanelManager(manager, ctx.extensionUri, refreshAllWithStatus);

  // --- File watcher: pick up external changes (CLI, Claude Code, other editors) ---
  // Debounce to avoid rapid-fire refreshes when many files change at once
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAllWithStatus, 300);
  };

  // Watch the global vault
  const globalWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(globalPath), '**/*.md')
  );
  globalWatcher.onDidCreate(debouncedRefresh);
  globalWatcher.onDidChange(debouncedRefresh);
  globalWatcher.onDidDelete(debouncedRefresh);
  ctx.subscriptions.push(globalWatcher);

  // Watch the workspace vault if it exists
  if (workspaceVaultPath) {
    const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(workspaceVaultPath), '**/*.md')
    );
    workspaceWatcher.onDidCreate(debouncedRefresh);
    workspaceWatcher.onDidChange(debouncedRefresh);
    workspaceWatcher.onDidDelete(debouncedRefresh);
    ctx.subscriptions.push(workspaceWatcher);
  }

  ctx.subscriptions.push(out);

  // --- Auto-open daily briefing (once per day, using globalState) ---
  if (config.get<boolean>('dailyBriefing.autoOpen')) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const lastBriefingDate = ctx.globalState.get<string>('groundwork.lastBriefingDate');
    if (lastBriefingDate !== todayStr) {
      setTimeout(async () => {
        await briefingPanel.open();
        await ctx.globalState.update('groundwork.lastBriefingDate', todayStr);
      }, 1500);
    }
  }

  // --- Gitignore check: if workspace vault exists but .groundwork/ isn't gitignored ---
  if (workspaceVaultExists && workspaceFolder) {
    // Deferred so it doesn't block activation
    setTimeout(() => promptGitignore(workspaceFolder.uri.fsPath), 2000);
  }

  // --- Staleness check on workspace open (deferred so it doesn't block activation) ---
  if (config.get<boolean>('autoDetectStaleness') && workspaceFolder) {
    // Run after a short delay so all commands are settled
    setTimeout(async () => {
      try {
        const staleResults = await checkStaleness(manager, workspaceFolder.uri.fsPath);
        const staleFiles = staleResults.filter(r => r.isStale);

        if (staleFiles.length > 0) {
          const missing = staleFiles.filter(r => r.aiFileMtime === null);
          const outdated = staleFiles.filter(r => r.aiFileMtime !== null);

          let message = 'Groundwork: ';
          if (missing.length > 0) {
            message += `${missing.map(r => r.file).join(', ')} can be generated. `;
          }
          if (outdated.length > 0) {
            message += `${outdated.map(r => r.file).join(', ')} may be outdated.`;
          }

          // Log to output channel — action buttons cause dev-mode errors, use output instead
          out.appendLine(`[Groundwork] Staleness: ${message.trim()}`);
          out.appendLine(`[Groundwork] Run "Groundwork: Generate CLAUDE.md" or "Groundwork: Generate Copilot Instructions" from the Command Palette`);
          // Show notification without action buttons to avoid dev-mode "extension not found" error
          vscode.window.showInformationMessage(message.trim());
        }
      } catch {
        // Silently ignore staleness errors — non-critical
      }
    }, 3000);
  }

  // --- Register MCP server for AI tool discovery (VS Code 1.99+) ---
  try {
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
      const mcpEmitter = new vscode.EventEmitter<void>();
      ctx.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('groundwork', {
          onDidChangeMcpServerDefinitions: mcpEmitter.event,
          provideMcpServerDefinitions: async () => {
            const serverScript = path.join(ctx.extensionPath, 'out', 'mcp', 'server.js');
            const mcpArgs = [serverScript, '--global-path', globalPath];
            if (manager.workspacePath) {
              mcpArgs.push('--workspace-path', manager.workspacePath);
            }
            return [
              new vscode.McpStdioServerDefinition(
                'Groundwork Vault',
                'node',
                mcpArgs,
                undefined,
                '0.5.0',
              ),
            ];
          },
          resolveMcpServerDefinition: async (server) => server,
        })
      );
      out.appendLine('[Groundwork] MCP server registered');
    }
  } catch {
    out.appendLine('[Groundwork] MCP server registration not available (VS Code < 1.99)');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a tree item (TaskItem or VaultFile) to a ParsedNote */
async function resolveNote(item: any): Promise<ParsedNote | undefined> {
  if (!item) return undefined;
  // TaskItem
  if (item.kind === 'item' && item.note) return item.note;
  // VaultFile (has path, not a directory)
  if (item.path && !item.isDirectory) return manager.readNote(item.path);
  return undefined;
}

// ── Task filter helpers ─────────────────────────────────────────────────────

/** Update VS Code context key so the Clear button shows/hides */
function syncFilterContext(taskTree: TaskTreeProvider): void {
  vscode.commands.executeCommand('setContext', 'groundwork.tagFilterActive', taskTree.hasActiveFilter);
}

/** Show/clear the view message banner when filters are active */
function updateViewMessage(taskTree: TaskTreeProvider, view: vscode.TreeView<any>): void {
  if (taskTree.hasActiveFilter) {
    view.message = `Filter: ${taskTree.getFilterDescription()}`;
  } else {
    view.message = undefined;
  }
}

// ── Vault filter helpers ────────────────────────────────────────────────────

function syncVaultFilterContext(vaultTree: VaultTreeProvider): void {
  vscode.commands.executeCommand('setContext', 'groundwork.vaultFilterActive', vaultTree.hasActiveFilter);
}

function updateVaultViewMessage(vaultTree: VaultTreeProvider, view: vscode.TreeView<any>): void {
  if (vaultTree.hasActiveFilter) {
    view.message = `Filter: ${vaultTree.getFilterDescription()}`;
  } else {
    view.message = undefined;
  }
}

async function showVaultFilterPicker(vaultTree: VaultTreeProvider, vaultView: vscode.TreeView<any>): Promise<void> {
  const currentFilter = vaultTree.filter;

  interface FilterOption extends vscode.QuickPickItem { key: string }
  const options: FilterOption[] = [
    {
      label: '$(note) Filter by Type',
      description: currentFilter.type ? `(active: ${currentFilter.type})` : '',
      key: 'type',
    },
    {
      label: '$(tag) Filter by Tag',
      description: currentFilter.tag ? `(active: ${currentFilter.tag})` : '',
      key: 'tag',
    },
    {
      label: '$(search) Search Text',
      description: currentFilter.search ? `(active: "${currentFilter.search}")` : '',
      key: 'search',
    },
  ];

  if (vaultTree.hasActiveFilter) {
    options.push({
      label: '$(close) Clear All Filters',
      description: vaultTree.getFilterDescription(),
      key: 'clear',
    });
  }

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: vaultTree.hasActiveFilter
      ? `Active: ${vaultTree.getFilterDescription()} — add/change a filter`
      : 'Choose a filter type',
  });
  if (!picked) return;

  if (picked.key === 'clear') {
    vaultTree.clearFilter();
    syncVaultFilterContext(vaultTree);
    updateVaultViewMessage(vaultTree, vaultView);
    return;
  }

  if (picked.key === 'search') {
    const query = await vscode.window.showInputBox({
      prompt: 'Search vault notes (title, body, tags, type)',
      placeHolder: 'Type to search…',
      value: currentFilter.search ?? '',
    });
    if (query === undefined) return;
    vaultTree.updateFilter('search', query || undefined);
    syncVaultFilterContext(vaultTree);
    updateVaultViewMessage(vaultTree, vaultView);
    return;
  }

  if (picked.key === 'type') {
    const typeOptions = [
      { label: 'note', description: '' },
      { label: 'reference', description: '' },
      { label: 'project', description: '' },
      { label: 'log', description: '' },
    ];
    if (currentFilter.type) {
      typeOptions.unshift({ label: '$(close) Clear type filter', description: '' });
    }
    const typePicked = await vscode.window.showQuickPick(typeOptions, {
      placeHolder: currentFilter.type
        ? `Filtering by type: "${currentFilter.type}" — pick a new value or clear`
        : 'Select a type',
    });
    if (!typePicked) return;
    if (typePicked.label.startsWith('$(close)')) {
      vaultTree.updateFilter('type', undefined);
    } else {
      vaultTree.updateFilter('type', typePicked.label);
    }
    syncVaultFilterContext(vaultTree);
    updateVaultViewMessage(vaultTree, vaultView);
    return;
  }

  if (picked.key === 'tag') {
    const tags = await vaultTree.getAllTags();
    if (tags.length === 0) {
      vscode.window.showInformationMessage('No tags found in vault notes.');
      return;
    }
    const tagOptions = tags.map(t => ({
      label: t,
      description: t === currentFilter.tag ? '(active)' : '',
    }));
    if (currentFilter.tag) {
      tagOptions.unshift({ label: '$(close) Clear tag filter', description: '' });
    }
    const tagPicked = await vscode.window.showQuickPick(tagOptions, {
      placeHolder: currentFilter.tag
        ? `Filtering by tag: "${currentFilter.tag}" — pick a new value or clear`
        : 'Select a tag',
    });
    if (!tagPicked) return;
    if (tagPicked.label.startsWith('$(close)')) {
      vaultTree.updateFilter('tag', undefined);
    } else {
      vaultTree.updateFilter('tag', tagPicked.label);
    }
    syncVaultFilterContext(vaultTree);
    updateVaultViewMessage(vaultTree, vaultView);
    return;
  }
}

/** Unified filter picker: choose dimension → choose value */
async function showFilterPicker(taskTree: TaskTreeProvider, tasksView: vscode.TreeView<any>): Promise<void> {
  const currentFilter = taskTree.filter;

  // Build the filter-type menu with current state shown
  interface FilterOption extends vscode.QuickPickItem { key: string }
  const options: FilterOption[] = [
    {
      label: '$(tag) Filter by Tag',
      description: currentFilter.tag ? `(active: ${currentFilter.tag})` : '',
      key: 'tag',
    },
    {
      label: '$(mention) Filter by Context',
      description: currentFilter.context ? `(active: ${currentFilter.context})` : '',
      key: 'context',
    },
    {
      label: '$(project) Filter by Project',
      description: currentFilter.project ? `(active: ${currentFilter.project})` : '',
      key: 'project',
    },
    {
      label: '$(search) Search Text',
      description: currentFilter.search ? `(active: "${currentFilter.search}")` : '',
      key: 'search',
    },
  ];

  // Add a "clear all" option if any filter is active
  if (taskTree.hasActiveFilter) {
    options.push({
      label: '$(close) Clear All Filters',
      description: taskTree.getFilterDescription(),
      key: 'clear',
    });
  }

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: taskTree.hasActiveFilter
      ? `Active: ${taskTree.getFilterDescription()} — add/change a filter`
      : 'Choose a filter type',
  });
  if (!picked) return;

  if (picked.key === 'clear') {
    taskTree.clearFilter();
    syncFilterContext(taskTree);
    updateViewMessage(taskTree, tasksView);
    return;
  }

  if (picked.key === 'search') {
    const query = await vscode.window.showInputBox({
      prompt: 'Search tasks (title, body, tags, project)',
      placeHolder: 'Type to search…',
      value: currentFilter.search ?? '',
    });
    if (query === undefined) return;
    taskTree.updateFilter('search', query || undefined);
    syncFilterContext(taskTree);
    updateViewMessage(taskTree, tasksView);
    return;
  }

  // Tag, Context, or Project → show values picker
  let values: string[] = [];
  let activeValue: string | undefined;

  if (picked.key === 'tag') {
    values = await taskTree.getAllTags();
    activeValue = currentFilter.tag;
  } else if (picked.key === 'context') {
    values = await taskTree.getAllContexts();
    activeValue = currentFilter.context;
  } else if (picked.key === 'project') {
    values = await taskTree.getAllProjects();
    activeValue = currentFilter.project;
  }

  if (values.length === 0) {
    vscode.window.showInformationMessage(`No ${picked.key}s found in any tasks.`);
    return;
  }

  const valueItems = values.map(v => ({
    label: v,
    description: v === activeValue ? '(active)' : '',
  }));

  // Add "clear this filter" if it's currently active
  if (activeValue) {
    valueItems.unshift({
      label: `$(close) Clear ${picked.key} filter`,
      description: '',
    });
  }

  const valuePicked = await vscode.window.showQuickPick(valueItems, {
    placeHolder: activeValue
      ? `Filtering by ${picked.key}: "${activeValue}" — pick a new value or clear`
      : `Select a ${picked.key}`,
  });
  if (!valuePicked) return;

  if (valuePicked.label.startsWith('$(close)')) {
    taskTree.updateFilter(picked.key as keyof TaskFilter, undefined);
  } else {
    taskTree.updateFilter(picked.key as keyof TaskFilter, valuePicked.label);
  }

  syncFilterContext(taskTree);
  updateViewMessage(taskTree, tasksView);
}

export function deactivate() {
  try {
    if (db?.isOpen) {
      db.saveToDisk();
      db.close();
    }
  } catch { /* extension shutting down */ }
}
