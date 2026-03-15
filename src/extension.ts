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
  const workspaceVaultPath = workspaceFolder
    ? path.join(workspaceFolder.uri.fsPath, '.kbvault')
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

    // Set Task Status (full status picker)
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

    // Compile Context for AI
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

  // --- Status bar item (always visible confirmation) ---
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(book) KB Vault';
  statusBar.tooltip = `KB Vault active\nGlobal: ${globalPath}${manager.workspacePath ? '\nWorkspace: ' + manager.workspacePath : ''}`;
  statusBar.command = 'kbvault.refresh';
  statusBar.show();
  ctx.subscriptions.push(statusBar);

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

          let message = 'KB Vault: ';
          if (missing.length > 0) {
            message += `${missing.map(r => r.file).join(', ')} can be generated. `;
          }
          if (outdated.length > 0) {
            message += `${outdated.map(r => r.file).join(', ')} may be outdated.`;
          }

          // Use commands directly — no extension lookup needed
          const action = await vscode.window.showInformationMessage(
            message.trim(),
            'Generate CLAUDE.md',
            'Generate Copilot',
            'Dismiss'
          );
          if (action === 'Generate CLAUDE.md') {
            await vscode.commands.executeCommand('kbvault.generateClaudeMd');
          } else if (action === 'Generate Copilot') {
            await vscode.commands.executeCommand('kbvault.generateCopilotInstructions');
          }
        }
      } catch {
        // Silently ignore staleness errors — non-critical
      }
    }, 3000);
  }
}

export function deactivate() {}
