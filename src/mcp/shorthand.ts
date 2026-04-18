import { GroundworkDB } from '../db/index';
import { TaskStatus } from '../vault/types';

/** Maps shorthand prefix letter to GTD status. */
export const STATUS_PREFIX: Record<string, TaskStatus> = {
  I: 'inbox',
  N: 'next',
  A: 'active',
  W: 'waiting',
  S: 'someday',
  D: 'done',
  C: 'cancelled',
};

/** Reverse map: status → prefix letter. */
export const PREFIX_FOR_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_PREFIX).map(([k, v]) => [v, k])
);

export interface ParsedShorthand {
  status: TaskStatus;
  index: number;
}

/** Parse a shorthand string like "N1" into { status, index }. Returns null if invalid. */
export function parseShorthand(ref: string): ParsedShorthand | null {
  if (!ref || ref.length < 2) return null;
  const prefix = ref[0].toUpperCase();
  const numStr = ref.slice(1);
  const index = parseInt(numStr, 10);

  if (!STATUS_PREFIX[prefix]) return null;
  if (isNaN(index) || index < 1 || String(index) !== numStr) return null;

  return { status: STATUS_PREFIX[prefix], index };
}

/**
 * Resolve a shorthand (N1, A2) to a file path via DB query.
 * Returns null if the ref can't be resolved.
 */
export function resolveShorthand(db: GroundworkDB, ref: string): string | null {
  // If it looks like an absolute path, return as-is
  if (ref.startsWith('/') || ref.includes('\\')) return ref;

  const parsed = parseShorthand(ref);
  if (!parsed) return null;

  // Query tasks for this status, sorted the same way as the tree view
  const rows = db.all<{ path: string }>(
    `SELECT path FROM notes
     WHERE type = 'task' AND status = ?
     ORDER BY
       CASE WHEN sort_order IS NOT NULL THEN 0 ELSE 1 END,
       sort_order,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
       title COLLATE NOCASE`,
    [parsed.status]
  );

  // 1-based index
  const row = rows[parsed.index - 1];
  return row?.path ?? null;
}

/**
 * Resolve a ref that may be a shorthand, absolute path, or relative path.
 * For relative paths, tries both vault roots.
 */
export function resolveRef(
  db: GroundworkDB,
  ref: string,
  globalRoot: string,
  workspaceRoot?: string
): string | null {
  // Absolute path
  if (ref.startsWith('/') || ref.includes('\\')) return ref;

  // Shorthand
  const shorthand = parseShorthand(ref);
  if (shorthand) return resolveShorthand(db, ref);

  // Relative path — try workspace first, then global
  const path = require('path');
  if (workspaceRoot) {
    const wsPath = path.join(workspaceRoot, ref);
    const exists = db.get('SELECT path FROM notes WHERE path = ?', [wsPath]);
    if (exists) return wsPath;
  }
  const globalPath = path.join(globalRoot, ref);
  const exists = db.get('SELECT path FROM notes WHERE path = ?', [globalPath]);
  if (exists) return globalPath;

  return null;
}
