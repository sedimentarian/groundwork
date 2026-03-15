import * as vscode from 'vscode';
import { VaultStore } from '../vault/store';
import { SessionEntry } from '../vault/types';

export class SessionTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private store: VaultStore) {}

  /** Start tracking editor activity within the vault */
  activate(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (this.isVaultFile(doc.uri)) {
          this.log({ action: 'open', file: doc.uri.fsPath });
        }
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (this.isVaultFile(doc.uri)) {
          this.log({ action: 'save', file: doc.uri.fsPath });
        }
      })
    );
  }

  async log(entry: Omit<SessionEntry, 'timestamp'>): Promise<void> {
    await this.store.logSession({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  private isVaultFile(uri: vscode.Uri): boolean {
    return uri.fsPath.startsWith(this.store.rootDir);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
