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
    const file = element as VaultFile;
    const item = new vscode.TreeItem(
      file.name,
      file.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!file.isDirectory) {
      item.command = {
        command: 'kbvault.openEditor',
        title: 'Open in WYSIWYG Editor',
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

    // VaultFile directory — return pre-populated children
    const dir = element as VaultFile;
    if (dir.isDirectory && dir.children) {
      return dir.children;
    }

    return [];
  }
}
