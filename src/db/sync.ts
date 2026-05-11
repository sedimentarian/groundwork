import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GroundworkDB } from './index';
import { upsertNote, deleteNote, NoteRow } from './queries';
import { parseFrontmatter } from '../vault/store';
import { NoteFrontmatter, VaultScope } from '../vault/types';

export interface VaultSource {
  rootDir: string;
  scope: VaultScope;
}

export interface ReindexStats {
  inserted: number;
  skipped: number;
  deleted: number;
}

/** Convert NoteFrontmatter to a NoteRow for DB storage. */
export function frontmatterToRow(
  fm: NoteFrontmatter,
  filePath: string,
  scope: VaultScope,
  bodyHash: string,
): NoteRow {
  return {
    path: filePath,
    scope,
    title: fm.title ?? null,
    type: fm.type ?? null,
    status: fm.status ?? null,
    priority: fm.priority ?? null,
    sort_order: typeof fm['sort-order'] === 'number' ? fm['sort-order'] : null,
    due: truncateDate(fm.due) ?? null,
    project: fm.project ?? null,
    context: fm.context ? JSON.stringify(fm.context) : null,
    tags: fm.tags ? JSON.stringify(fm.tags) : null,
    recurrence: fm.recurrence ?? null,
    created: truncateDate(fm.created) ?? null,
    modified: truncateDate(fm.modified) ?? null,
    body_hash: bodyHash,
    indexed_at: new Date().toISOString(),
  };
}

/** Truncate ISO timestamp to YYYY-MM-DD date string. Passthrough if already date-only. */
function truncateDate(val: string | undefined): string | null {
  if (!val) return null;
  return val.slice(0, 10); // '2026-04-01T14:30:00.000Z' → '2026-04-01'
}

/** Walk vault directories and sync all .md files into the DB. */
export async function reindex(db: GroundworkDB, vaults: VaultSource[]): Promise<ReindexStats> {
  const stats: ReindexStats = { inserted: 0, skipped: 0, deleted: 0 };
  const seenPaths = new Set<string>();

  for (const vault of vaults) {
    const files = await collectMarkdownFiles(vault.rootDir);

    for (const filePath of files) {
      seenPaths.add(filePath);

      // Check mtime against indexed_at
      const fileStat = await fs.promises.stat(filePath);
      const fileMtime = fileStat.mtime.toISOString();

      const existing = db.get<{ indexed_at: string | null }>('SELECT indexed_at FROM notes WHERE path = ?', [filePath]);
      if (existing?.indexed_at && existing.indexed_at >= fileMtime) {
        stats.skipped++;
        continue;
      }

      // Read and parse file
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);

      const row = frontmatterToRow(frontmatter, filePath, vault.scope, bodyHash);
      upsertNote(db, row, body);
      stats.inserted++;
    }
  }

  // Delete DB rows for files that no longer exist, but only under the vault
  // roots that were actually scanned. Rows from unscanned vaults must stay.
  const scannedRoots = vaults.map(v => path.resolve(v.rootDir));
  const allDbPaths = db.all<{ path: string }>('SELECT path FROM notes');
  for (const { path: dbPath } of allDbPaths) {
    if (seenPaths.has(dbPath)) continue;
    const ownedByScannedRoot = scannedRoots.some(root => dbPath.startsWith(root + path.sep));
    if (ownedByScannedRoot) {
      deleteNote(db, dbPath);
      stats.deleted++;
    }
  }

  return stats;
}

/** Recursively collect all .md files in a directory, skipping hidden dirs. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // Directory doesn't exist
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue; // Skip hidden (.sessions, etc.)

    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}
