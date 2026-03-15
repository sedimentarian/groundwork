import * as fs from 'fs';
import * as path from 'path';
import { VaultManager } from './manager';

export interface StalenessResult {
  file: string;
  isStale: boolean;
  aiFileMtime: Date | null;
  vaultMtime: Date;
}

/**
 * Check if AI instruction files are stale relative to vault content.
 * A file is stale if any vault content was modified after the AI file,
 * or if the AI file doesn't exist but the vault has active content.
 */
export async function checkStaleness(
  manager: VaultManager,
  workspacePath: string
): Promise<StalenessResult[]> {
  const results: StalenessResult[] = [];
  const vaultMtime = await getLatestVaultMtime(manager);

  const aiFiles = [
    path.join(workspacePath, 'CLAUDE.md'),
    path.join(workspacePath, '.github', 'copilot-instructions.md'),
  ];

  for (const aiFile of aiFiles) {
    try {
      const stat = await fs.promises.stat(aiFile);
      results.push({
        file: path.basename(aiFile),
        isStale: vaultMtime > stat.mtime,
        aiFileMtime: stat.mtime,
        vaultMtime,
      });
    } catch {
      // File doesn't exist — only report if vault has active content
      const hasContent = await hasActiveContent(manager);
      if (hasContent) {
        results.push({
          file: path.basename(aiFile),
          isStale: true,
          aiFileMtime: null,
          vaultMtime,
        });
      }
    }
  }

  return results;
}

async function getLatestVaultMtime(manager: VaultManager): Promise<Date> {
  let latest = new Date(0);

  for (const scope of ['global', 'workspace'] as const) {
    const rootDir = manager.rootDirFor(scope);
    if (!rootDir) continue;

    const mtime = await getLatestMtimeInDir(rootDir);
    if (mtime > latest) latest = mtime;
  }

  return latest;
}

async function getLatestMtimeInDir(dir: string): Promise<Date> {
  let latest = new Date(0);

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subMtime = await getLatestMtimeInDir(fullPath);
        if (subMtime > latest) latest = subMtime;
      } else if (entry.name.endsWith('.md')) {
        const stat = await fs.promises.stat(fullPath);
        if (stat.mtime > latest) latest = stat.mtime;
      }
    }
  } catch {
    // Directory doesn't exist or is inaccessible
  }

  return latest;
}

async function hasActiveContent(manager: VaultManager): Promise<boolean> {
  const tasks = await manager.queryNotes({ type: 'task', status: 'active' });
  const next = await manager.queryNotes({ type: 'task', status: 'next' });
  return tasks.length > 0 || next.length > 0;
}
