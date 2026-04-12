import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema } from './schema';
import { upsertNote, deleteNote, listTasks, getNote, taskStats, searchNotes, NoteRow } from './queries';

function makeRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: '/test/task.md',
    scope: 'global',
    title: 'Test Task',
    type: 'task',
    status: 'inbox',
    priority: 'medium',
    sort_order: null,
    due: null,
    project: null,
    context: null,
    tags: null,
    recurrence: null,
    created: '2026-04-01',
    modified: '2026-04-01',
    body_hash: 'abc',
    indexed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('queries', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-queries-test-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('upsertNote', () => {
    it('should insert a new row', () => {
      upsertNote(db, makeRow());
      const row = db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Test Task');
    });

    it('should update an existing row', () => {
      upsertNote(db, makeRow());
      upsertNote(db, makeRow({ title: 'Updated' }));
      const row = db.get<NoteRow>('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row!.title).toBe('Updated');
    });

    it('should maintain FTS entry on upsert', () => {
      upsertNote(db, makeRow({ title: 'Findable Task' }));
      const results = searchNotes(db, 'Findable');
      expect(results.length).toBe(1);
    });
  });

  describe('deleteNote', () => {
    it('should remove a row by path', () => {
      upsertNote(db, makeRow());
      deleteNote(db, '/test/task.md');
      const row = db.get('SELECT * FROM notes WHERE path = ?', ['/test/task.md']);
      expect(row).toBeNull();
    });

    it('should remove FTS entry on delete', () => {
      upsertNote(db, makeRow({ title: 'Gone Task' }));
      deleteNote(db, '/test/task.md');
      const results = searchNotes(db, 'Gone');
      expect(results.length).toBe(0);
    });
  });

  describe('listTasks', () => {
    it('should return tasks filtered by status', () => {
      upsertNote(db, makeRow({ path: '/a.md', status: 'next', title: 'A' }));
      upsertNote(db, makeRow({ path: '/b.md', status: 'inbox', title: 'B' }));
      upsertNote(db, makeRow({ path: '/c.md', status: 'next', title: 'C' }));

      const next = listTasks(db, { status: 'next' });
      expect(next.length).toBe(2);
      expect(next.map(r => r.title)).toEqual(['A', 'C']);
    });

    it('should sort by sort_order (nulls last), then priority, then title', () => {
      upsertNote(db, makeRow({ path: '/a.md', title: 'Z', sort_order: 10, priority: 'low' }));
      upsertNote(db, makeRow({ path: '/b.md', title: 'A', sort_order: null, priority: 'high' }));
      upsertNote(db, makeRow({ path: '/c.md', title: 'M', sort_order: null, priority: 'high' }));

      const tasks = listTasks(db, {});
      expect(tasks.map(r => r.title)).toEqual(['Z', 'A', 'M']);
    });

    it('should filter by project', () => {
      upsertNote(db, makeRow({ path: '/a.md', project: 'Alpha' }));
      upsertNote(db, makeRow({ path: '/b.md', project: 'Beta' }));

      const alpha = listTasks(db, { project: 'Alpha' });
      expect(alpha.length).toBe(1);
      expect(alpha[0].project).toBe('Alpha');
    });

    it('should filter by tag (JSON array contains)', () => {
      upsertNote(db, makeRow({ path: '/a.md', tags: '["api","backend"]' }));
      upsertNote(db, makeRow({ path: '/b.md', tags: '["frontend"]' }));

      const api = listTasks(db, { tag: 'api' });
      expect(api.length).toBe(1);
    });
  });

  describe('taskStats', () => {
    it('should return counts grouped by status', () => {
      upsertNote(db, makeRow({ path: '/a.md', status: 'inbox' }));
      upsertNote(db, makeRow({ path: '/b.md', status: 'inbox' }));
      upsertNote(db, makeRow({ path: '/c.md', status: 'next' }));
      upsertNote(db, makeRow({ path: '/d.md', type: 'note' })); // not a task

      const stats = taskStats(db);
      expect(stats.inbox).toBe(2);
      expect(stats.next).toBe(1);
      expect(stats.active).toBe(0);
    });
  });

  describe('searchNotes', () => {
    it('should find notes by title via FTS', () => {
      upsertNote(db, makeRow({ path: '/a.md', title: 'Deploy the API' }));
      upsertNote(db, makeRow({ path: '/b.md', title: 'Write docs' }));

      const results = searchNotes(db, 'API');
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('/a.md');
    });

    it('should return empty array for no matches', () => {
      upsertNote(db, makeRow({ path: '/a.md', title: 'Deploy' }));
      const results = searchNotes(db, 'nonexistent');
      expect(results.length).toBe(0);
    });
  });

  describe('getNote', () => {
    it('should return a note by path', () => {
      upsertNote(db, makeRow({ path: '/found.md', title: 'Found' }));
      const note = getNote(db, '/found.md');
      expect(note).not.toBeNull();
      expect(note!.title).toBe('Found');
    });

    it('should return null for missing path', () => {
      const note = getNote(db, '/missing.md');
      expect(note).toBeNull();
    });
  });
});
