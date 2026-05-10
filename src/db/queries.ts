import { GroundworkDB } from './index';

/** Shape of a row in the notes table. */
export interface NoteRow {
  path: string;
  scope: string;
  title: string | null;
  type: string | null;
  status: string | null;
  priority: string | null;
  sort_order: number | null;
  due: string | null;
  project: string | null;
  context: string | null;   // JSON array string
  tags: string | null;       // JSON array string
  recurrence: string | null;
  created: string | null;
  modified: string | null;
  body_hash: string | null;
  indexed_at: string | null;
}

export interface TaskFilter {
  status?: string;
  priority?: string;
  project?: string;
  scope?: string;
  tag?: string;
  context?: string;
  limit?: number;
}

/** Insert or update a note row. Also updates the FTS index. */
export function upsertNote(db: GroundworkDB, row: NoteRow, body = ''): void {
  // Delete existing FTS entry if updating
  db.run('DELETE FROM notes_fts WHERE path = ?', [row.path]);

  db.run(
    `INSERT OR REPLACE INTO notes
     (path, scope, title, type, status, priority, sort_order, due, project, context, tags, recurrence, created, modified, body_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.path, row.scope, row.title, row.type, row.status, row.priority,
      row.sort_order, row.due, row.project, row.context, row.tags, row.recurrence,
      row.created, row.modified, row.body_hash, row.indexed_at,
    ]
  );

  // Insert FTS entry
  db.run(
    'INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)',
    [row.path, row.title ?? '', body]
  );
}

/** Delete a note row by path. Also removes FTS entry. */
export function deleteNote(db: GroundworkDB, notePath: string): void {
  db.run('DELETE FROM notes_fts WHERE path = ?', [notePath]);
  db.run('DELETE FROM notes WHERE path = ?', [notePath]);
}

/** List tasks with optional filters. Sorted by sort_order, priority, title. */
export function listTasks(db: GroundworkDB, filter: TaskFilter): NoteRow[] {
  const clauses: string[] = ["type = 'task'"];
  const params: unknown[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.priority) {
    clauses.push('priority = ?');
    params.push(filter.priority);
  }
  if (filter.project) {
    clauses.push('project = ?');
    params.push(filter.project);
  }
  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.tag) {
    // JSON array contains — tags is stored as '["api","backend"]'
    clauses.push("tags LIKE '%' || ? || '%'");
    params.push(`"${filter.tag}"`);
  }
  if (filter.context) {
    clauses.push("context LIKE '%' || ? || '%'");
    params.push(`"${filter.context}"`);
  }

  const where = clauses.join(' AND ');
  const limit = filter.limit ?? 500;

  // Priority sort: high=0, medium=1, low=2, null=1
  return db.all<NoteRow>(
    `SELECT * FROM notes
     WHERE ${where}
     ORDER BY
       CASE WHEN sort_order IS NOT NULL THEN 0 ELSE 1 END,
       sort_order,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
       title COLLATE NOCASE
     LIMIT ?`,
    [...params, limit]
  );
}

/** Get a single note by path. */
export function getNote(db: GroundworkDB, notePath: string): NoteRow | null {
  return db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', [notePath]);
}

/** Get all notes of a given type. */
export function listByType(db: GroundworkDB, type: string, scope?: string): NoteRow[] {
  if (scope) {
    return db.all<NoteRow>(
      'SELECT * FROM notes WHERE type = ? AND scope = ? ORDER BY title COLLATE NOCASE',
      [type, scope]
    );
  }
  return db.all<NoteRow>(
    'SELECT * FROM notes WHERE type = ? ORDER BY title COLLATE NOCASE',
    [type]
  );
}

/** Get metadata for all notes (used by vault tree for icon/title lookup). */
export function allNoteMetadata(db: GroundworkDB, scope?: string): NoteRow[] {
  if (scope) {
    return db.all<NoteRow>('SELECT * FROM notes WHERE scope = ?', [scope]);
  }
  return db.all<NoteRow>('SELECT * FROM notes');
}

/** Count tasks grouped by status. */
export function taskStats(db: GroundworkDB): Record<string, number> {
  const rows = db.all<{ status: string; count: number }>(
    "SELECT status, COUNT(*) as count FROM notes WHERE type = 'task' GROUP BY status"
  );
  const stats: Record<string, number> = {
    inbox: 0, next: 0, active: 0, waiting: 0, someday: 0, done: 0, cancelled: 0,
  };
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats;
}

/** Full-text search with tiered AND→OR strategy and bm25 ranking.
 *  Title matches weighted 5x over body. Falls back to OR when AND yields < minResults. */
export function searchNotes(db: GroundworkDB, query: string, filter?: { type?: string; status?: string; scope?: string }, limit = 20): NoteRow[] {
  const minResults = 3;

  // Pass through FTS5 operators (quotes, *, OR) as-is.
  // For plain multi-word queries, try AND first, then OR.
  const hasOperators = /["\*]|\b(?:OR|AND|NOT|NEAR)\b/i.test(query);

  let ftsResults: { path: string }[];

  if (hasOperators) {
    ftsResults = ftsQuery(db, query, limit);
  } else {
    // Tier 1: implicit AND (all words must appear)
    ftsResults = ftsQuery(db, query, limit);

    // Tier 2: fall back to OR if AND yields too few
    if (ftsResults.length < minResults) {
      const words = query.trim().split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        const orQuery = words.join(' OR ');
        const orResults = ftsQuery(db, orQuery, limit);
        // Merge, preserving AND results first (they're more relevant)
        const seen = new Set(ftsResults.map(r => r.path));
        for (const r of orResults) {
          if (!seen.has(r.path)) {
            ftsResults.push(r);
            seen.add(r.path);
          }
        }
      }
    }
  }

  if (ftsResults.length === 0) return [];

  // Look up full rows from notes table with optional filters
  const placeholders = ftsResults.map(() => '?').join(',');
  const paths = ftsResults.map(r => r.path);

  const clauses: string[] = [`path IN (${placeholders})`];
  const params: unknown[] = [...paths];

  if (filter?.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }

  // Preserve FTS ranking order via CASE expression
  const orderCases = paths.map((_, i) => `WHEN ? THEN ${i}`).join(' ');
  params.push(...paths);

  return db.all<NoteRow>(
    `SELECT * FROM notes WHERE ${clauses.join(' AND ')}
     ORDER BY CASE path ${orderCases} END
     LIMIT ?`,
    [...params, limit]
  );
}

/** Run a single FTS5 query, ranked by bm25 with title weighted 5x over body. */
function ftsQuery(db: GroundworkDB, query: string, limit: number): { path: string }[] {
  try {
    return db.all<{ path: string }>(
      `SELECT path FROM notes_fts WHERE notes_fts MATCH ?
       ORDER BY bm25(notes_fts, 0, 5.0, 1.0)
       LIMIT ?`,
      [query, limit]
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('fts5') || msg.includes('parse') || msg.includes('syntax')) {
      return [];
    }
    throw err;
  }
}
