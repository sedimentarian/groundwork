import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { VaultStore } from './vault/store';
import { TaskStatus, GTD_LISTS } from './vault/types';
import { ContextGenerator } from './context/generator';
import { SessionTracker } from './session/tracker';
import { VaultTreeProvider } from './views/vault-tree';
import { TaskTreeProvider } from './views/task-tree';
import { SessionTreeProvider } from './views/session-tree';

let store: VaultStore;
let contextGen: ContextGenerator;
let sessionTracker: SessionTracker;

export async function activate(ctx: vscode.ExtensionContext) {
  // Resolve vault path
  const config = vscode.workspace.getConfiguration('knowledgeVault');
  const configuredPath = config.get<string>('vaultPath');
  const vaultPath = configuredPath || path.join(os.homedir(), '.knowledge-vault');

  // Init core
  store = new VaultStore(vaultPath);
  await store.init();
  contextGen = new ContextGenerator(store);
  sessionTracker = new SessionTracker(store);
  sessionTracker.activate();
  ctx.subscriptions.push(sessionTracker);

  // Tree views
  const vaultTree = new VaultTreeProvider(store);
  const taskTree = new TaskTreeProvider(store);
  const sessionTree = new SessionTreeProvider(store);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('knowledgeVault.vault', vaultTree),
    vscode.window.registerTreeDataProvider('knowledgeVault.tasks', taskTree),
    vscode.window.registerTreeDataProvider('knowledgeVault.sessions', sessionTree),
  );

  // --- Commands ---

  ctx.subscriptions.push(
    vscode.commands.registerCommand('knowledgeVault.refresh', () => {
      vaultTree.refresh();
      taskTree.refresh();
      sessionTree.refresh();
    }),

    vscode.commands.registerCommand('knowledgeVault.openVault', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select Vault Folder',
      });
      if (!uris?.[0]) return;

      const newPath = uris[0].fsPath;
      await config.update('vaultPath', newPath, vscode.ConfigurationTarget.Global);
      store = new VaultStore(newPath);
      await store.init();
      contextGen = new ContextGenerator(store);

      vaultTree.refresh();
      taskTree.refresh();
      vscode.window.showInformationMessage(`Vault set to: ${newPath}`);
    }),

    vscode.commands.registerCommand('knowledgeVault.newNote', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Note title',
        placeHolder: 'My new note',
      });
      if (!title) return;

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = path.join(store.rootDir, 'reference', `${slug}.md`);

      await store.writeNote(filePath, {
        title,
        type: 'note',
        created: new Date().toISOString(),
        tags: [],
      }, `\n# ${title}\n\n`);

      await sessionTracker.log({ action: 'create', file: filePath });
      vaultTree.refresh();

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('knowledgeVault.newTask', async () => {
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

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filePath = path.join(store.rootDir, 'inbox', `${slug}.md`);

      await store.writeNote(filePath, {
        title,
        type: 'task',
        status: 'inbox',
        context: selectedContexts ?? [],
        project: project || undefined,
        created: new Date().toISOString(),
        priority: 'medium',
      }, `\n${title}\n\n## Notes\n\n`);

      await sessionTracker.log({ action: 'create', file: filePath });
      vaultTree.refresh();
      taskTree.refresh();

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('knowledgeVault.setTaskStatus', async (item?: unknown) => {
      // If called from context menu, item is a tree node; otherwise prompt for file
      let filePath: string | undefined;

      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.fsPath.startsWith(store.rootDir)) {
        filePath = editor.document.uri.fsPath;
      }

      if (!filePath) {
        vscode.window.showWarningMessage('Open a vault task file first.');
        return;
      }

      const note = await store.readNote(filePath);
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
      await store.writeNote(filePath, note.frontmatter, note.body);

      await sessionTracker.log({
        action: 'status_change',
        file: filePath,
        detail: `${currentStatus} → ${picked.value}`,
      });

      taskTree.refresh();
      vscode.window.showInformationMessage(`Task moved to: ${GTD_LISTS[picked.value]}`);
    }),

    vscode.commands.registerCommand('knowledgeVault.compileContext', async () => {
      const allFiles = await store.queryNotes({});
      const items = allFiles.map(n => ({
        label: n.frontmatter.title ?? n.relativePath,
        description: [n.frontmatter.type, n.frontmatter.status].filter(Boolean).join(' | '),
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

      // Open in a new untitled document
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

    vscode.commands.registerCommand('knowledgeVault.generateClaudeMd', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const content = await contextGen.generateClaudeMd(workspaceFolder.uri.fsPath);
      const targetPath = path.join(workspaceFolder.uri.fsPath, 'CLAUDE.md');

      // Show preview first
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

    vscode.commands.registerCommand('knowledgeVault.generateCopilotInstructions', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
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

    vscode.commands.registerCommand('knowledgeVault.logActivity', async () => {
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

  vscode.window.showInformationMessage(`Knowledge Vault active: ${vaultPath}`);
}

export function deactivate() {}
