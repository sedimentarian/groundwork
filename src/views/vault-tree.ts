import * as vscode from 'vscode';
import * as path from 'path';
import { VaultStore } from '../vault/store';
import { VaultFile } from '../vault/types';

export class VaultTreeProvider implements vscode.TreeDataProvider<VaultFile> {
  private _onDidChangeTreeData = new vscode.EventEmitter<VaultFile | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: VaultStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: VaultFile): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      element.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!element.isDirectory) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Note',
        arguments: [vscode.Uri.file(element.path)],
      };
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'vault-file';
    } else {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'vault-folder';
    }

    item.tooltip = element.relativePath;
    return item;
  }

  async getChildren(element?: VaultFile): Promise<VaultFile[]> {
    const dir = element?.path ?? this.store.rootDir;
    try {
      return await this.store.listFiles(dir);
    } catch {
      return [];
    }
  }
}
