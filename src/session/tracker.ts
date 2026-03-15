import * as vscode from 'vscode';
import { VaultManager } from '../vault/manager';
import { SessionEntry } from '../vault/types';

export class SessionTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private manager: VaultManager) {}

  /** Start tracking editor activity within the vault */
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
