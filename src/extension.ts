import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { VaultManager } from './vault/manager';
import { TaskStatus, GTD_LISTS, VaultScope, ParsedNote } from './vault/types';
import { ContextGenerator } from './context/generator';
import { SessionTracker } from './session/tracker';
import { VaultTreeProvider } from './views/vault-tree';
import { TaskTreeProvider, TaskItem, TaskFilter } from './views/task-tree';
import { SessionTreeProvider } from './views/session-tree';
import { checkStaleness } from './vault/staleness';
import { EditorPanelManager } from './views/editor-panel';
import { BriefingPanelManager } from './views/briefing-panel';
import { pickNoteCreationMethod, pickTaskCreationMethod } from './note-creation';
import { runWeeklyReview } from './weekly-review';

let manager: VaultManager;
let contextGen: ContextGenerator;
let sessionTracker: SessionTracker;
let editorPanels: EditorPanelManager;
let briefingPanel: BriefingPanelManager;

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

  contextGen = new ContextGenerator(manager);
  sessionTracker = new SessionTracker(manager);
  sessionTracker.activate();
  ctx.subscriptions.push(sessionTracker);

  // Output channel — declared early so commands can log to it
  const out = vscode.window.createOutputChannel('Groundwork');
  out.appendLine(`[Groundwork] Activated`);
  out.appendLine(`[Groundwork] Global vault: ${globalPath}`);
  if (manager.workspacePath) out.appendLine(`[Groundwork] Workspace vault: ${manager.workspacePath}`);

  // Tree views
  const vaultTree = new VaultTreeProvider(manager);
  const taskTree = new TaskTreeProvider(manager);
  const sessionTree = new SessionTreeProvider(manager);

  const refreshAll = () => {
    vaultTree.refresh();
    taskTree.refresh();
    sessionTree.refresh();
  };

  editorPanels = new EditorPanelManager(manager, ctx.extensionUri, refreshAll);
  briefingPanel = new BriefingPanelManager(manager, ctx.extensionUri, refreshAll);

  // Tasks tree view — createTreeView (not registerTreeDataProvider) so we can use onDidChangeCheckboxState + drag-and-drop
  const tasksView = vscode.window.createTreeView('groundwork.tasks', {
    treeDataProvider: taskTree,
    dragAndDropController: taskTree,
    showCollapseAll: false,
    canSelectMany: false,
  });

  // When a task is moved via drag-and-drop, log the session event
  taskTree.onTaskDropped = async (filePath: string, detail: string) => {
    await sessionTracker.log({ action: 'status_change', file: filePath, detail });
  };

  // Checkbox click → mark done (checked) or pick a new status (unchecked)
  tasksView.onDidChangeCheckboxState(async e => {
    for (const [element, state] of e.items) {
      if (!('kind' in element && element.kind === 'item')) continue;
      const note = await manager.readNote(element.note.path);
      const previousStatus = note.frontmatter.status ?? 'inbox';

      let newStatus: TaskStatus;
      if (state === vscode.TreeItemCheckboxState.Checked) {
        newStatus = 'done';
      } else {
        // Unchecking a done/cancelled task → ask where it should go
        const reopenOptions: TaskStatus[] = ['next', 'inbox', 'active', 'waiting', 'someday'];
        const picked = await vscode.window.showQuickPick(
          reopenOptions.map(s => ({ label: GTD_LISTS[s], value: s })),
          { placeHolder: 'Reopen task as…' }
        );
        if (!picked) {
          // User cancelled — refresh to restore visual checkbox state
          taskTree.refresh();
          return;
        }
        newStatus = picked.value;
      }

      note.frontmatter.status = newStatus;
      await manager.writeNote(element.note.path, note.frontmatter, note.body);
      await sessionTracker.log({
        action: 'status_change',
        file: element.note.path,
        detail: `${previousStatus} → ${newStatus}`,
      });
    }
    taskTree.refresh();
    sessionTree.refresh();
  });

  ctx.subscriptions.push(
    tasksView,
    vscode.window.registerTreeDataProvider('groundwork.vault', vaultTree),
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
      await manager.initWorkspace(wPath);
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
        await manager.initWorkspace(wPath);
        refreshAll();
      }
      const rootDir = manager.rootDirFor('workspace');
      if (!rootDir) return undefined;
      return { scope: 'workspace', rootDir };
    }

    return { scope: 'global', rootDir: manager.globalPath };
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
      contextGen = new ContextGenerator(manager);

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
      await manager.initWorkspace(wPath);
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
        await manager.initWorkspace(path.join(workspaceFolder.uri.fsPath, '.groundwork'));
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

    // Move task to global vault
    vscode.commands.registerCommand('groundwork.moveToGlobal', async (item?: TaskItem) => {
      if (!item) { vscode.window.showWarningMessage('Select a task first.'); return; }
      await moveNote(item.note, 'global');
    }),

    // Move task to workspace vault
    vscode.commands.registerCommand('groundwork.moveToWorkspace', async (item?: TaskItem) => {
      if (!item) { vscode.window.showWarningMessage('Select a task first.'); return; }
      await moveNote(item.note, 'workspace');
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

    // Generate CLAUDE.md
    vscode.commands.registerCommand('groundwork.generateClaudeMd', async () => {
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
    vscode.commands.registerCommand('groundwork.generateCopilotInstructions', async () => {
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

    // Daily Briefing
    vscode.commands.registerCommand('groundwork.dailyBriefing', async () => {
      await briefingPanel.open();
    }),

    // Weekly Review — guided GTD review wizard
    vscode.commands.registerCommand('groundwork.weeklyReview', async () => {
      await runWeeklyReview(manager, sessionTracker, refreshAll);
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
  // Patch the refreshAll reference used by editor panels and briefing
  editorPanels = new EditorPanelManager(manager, ctx.extensionUri, refreshAllWithStatus);
  briefingPanel = new BriefingPanelManager(manager, ctx.extensionUri, refreshAllWithStatus);

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
}

// ── Filter helpers ───────────────────────────────────────────────────────────

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

export function deactivate() {}
