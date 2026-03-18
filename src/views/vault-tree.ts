import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { VaultFile, VaultScope } from '../vault/types';

/** A root node representing a vault scope */
class VaultRoot {
  constructor(
    public readonly scope: VaultScope,
    public readonly label: string,
    public readonly rootDir: string
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
      const label = element.scope === 'global' ? '🌐 Global Vault' : '📂 Workspace Vault';
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(icon);
      item.contextValue = `vault-root-${element.scope}`;
      item.tooltip = `Root: ${element.rootDir}`;
      return item;
    }

    // VaultFile
    const file = element as VaultFile;
    const displayName = file.isDirectory
      ? file.name
      : (file.title ?? slugToTitle(file.name.replace(/\.md$/, '')));

    const item = new vscode.TreeItem(
      displayName,
      file.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!file.isDirectory) {
      item.command = {
        command: 'groundwork.openEditor',
        title: 'Open in WYSIWYG Editor',
        arguments: [vscode.Uri.file(file.path)],
      };
      item.iconPath = new vscode.ThemeIcon(fileIcon(file));
      item.contextValue = 'vault-file';

      // Description: scope badge + type label
      const scopeEmoji = file.source === 'workspace' ? '📂' : '🌐';
      const typeLabel = file.noteType ? ` · ${file.noteType}` : '';
      item.description = `${scopeEmoji}${typeLabel}`;

      // Tooltip with full path
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`**${displayName}**\n\n`);
      md.appendMarkdown(`| | |\n|:---|:---|\n`);
      md.appendMarkdown(`| 📄 File | \`${file.relativePath}\` |\n`);
      md.appendMarkdown(`| 🌐 Scope | ${file.source === 'workspace' ? 'Workspace' : 'Global'} |\n`);
      if (file.noteType) md.appendMarkdown(`| 🏷 Type | ${file.noteType} |\n`);
      item.tooltip = md;

    } else {
      item.iconPath = new vscode.ThemeIcon(dirIcon(file.name));
      item.contextValue = 'vault-folder';
      item.tooltip = file.relativePath;

      // Show count of files inside
      const fileCount = countFiles(file);
      if (fileCount > 0) {
        item.description = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
      }
    }

    return item;
  }

  async getChildren(element?: VaultTreeItem): Promise<VaultTreeItem[]> {
    if (!element) {
      // Root level: show scope roots
      const roots: VaultTreeItem[] = [];
      if (this.manager.workspaceStore) {
        roots.push(new VaultRoot('workspace', '📂 Workspace', this.manager.workspacePath!));
      }
      roots.push(new VaultRoot('global', '🌐 Global', this.manager.globalPath));
      return roots;
    }

    if (element instanceof VaultRoot) {
      const store = this.manager.storeFor(element.scope);
      if (!store) return [];
      try {
        const files = await store.listFiles();
        return filterVaultFiles(files);
      } catch {
        return [];
      }
    }

    // VaultFile directory — return pre-populated (already filtered) children
    const dir = element as VaultFile;
    if (dir.isDirectory && dir.children) {
      return dir.children;
    }

    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a slug filename to a readable title */
function slugToTitle(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Choose icon based on note type or directory context */
function fileIcon(file: VaultFile): string {
  const type = file.noteType;
  if (!type) {
    // Fall back to directory-based guess
    const dir = path.dirname(file.relativePath);
    if (dir === 'inbox') return 'circle-outline';
    if (dir === 'reference') return 'book';
    if (dir === 'projects') return 'project';
    if (dir === 'logs') return 'output';
    return 'file';
  }
  switch (type) {
    case 'task':      return 'checklist';
    case 'reference': return 'book';
    case 'note':      return 'note';
    case 'log':       return 'output';
    case 'project':   return 'project';
    default:          return 'file';
  }
}

/** Choose icon for well-known vault directories */
function dirIcon(name: string): string {
  switch (name) {
    case 'inbox':     return 'inbox';
    case 'projects':  return 'project';
    case 'reference': return 'book';
    case 'logs':      return 'output';
    default:          return 'folder';
  }
}

/**
 * Remove task files from vault view — tasks belong exclusively in the Tasks panel.
 * Also prunes directories that become empty after filtering.
 */
function filterVaultFiles(files: VaultFile[]): VaultFile[] {
  const result: VaultFile[] = [];
  for (const file of files) {
    if (!file.isDirectory) {
      // Skip tasks — they live in the Tasks panel, not here
      if (file.noteType === 'task') continue;
      result.push(file);
    } else {
      // Recurse into directories, pruning empty ones
      const filteredChildren = filterVaultFiles(file.children ?? []);
      if (filteredChildren.length === 0) continue; // hide empty dirs
      result.push({ ...file, children: filteredChildren });
    }
  }
  return result;
}

/** Count non-directory descendants */
function countFiles(file: VaultFile): number {
  if (!file.children) return 0;
  let count = 0;
  for (const child of file.children) {
    if (!child.isDirectory) count++;
    else count += countFiles(child);
  }
  return count;
}
