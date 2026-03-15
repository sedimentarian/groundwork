import * as vscode from 'vscode';
import * as path from 'path';
import { VaultStore } from '../vault/store';
import { SessionEntry } from '../vault/types';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: VaultStore) {}

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
      const entries = await this.store.getRecentSessions(3);
      return entries.slice(0, 50); // Show last 50 entries
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
