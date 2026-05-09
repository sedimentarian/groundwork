import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema } from './schema';
import { frontmatterToRow, reindex } from './sync';
import { NoteRow } from './queries';
import { NoteFrontmatter } from '../vault/types';

describe('frontmatterToRow', () => {
  it('should map hyphenated keys to snake_case columns', () => {
    const fm: NoteFrontmatter = {
      title: 'Test',
      type: 'task',
      status: 'next',
      'sort-order': 20,
      tags: ['api', 'backend'],
      context: ['@computer'],
    };
    const row = frontmatterToRow(fm, '/test.md', 'global', 'hash123');

    expect(row.sort_order).toBe(20);
    expect(row.tags).toBe('["api","backend"]');
    expect(row.context).toBe('["@computer"]');
    expect(row.scope).toBe('global');
  });

  it('should truncate ISO timestamps to date-only strings', () => {
    const fm: NoteFrontmatter = {
      title: 'Test',
      created: '2026-04-01T14:30:00.000Z',
      modified: '2026-04-02T09:00:00.000Z',
      due: '2026-05-01',
    };
    const row = frontmatterToRow(fm, '/test.md', 'global', 'hash');

    expect(row.created).toBe('2026-04-01');
    expect(row.modified).toBe('2026-04-02');
    expect(row.due).toBe('2026-05-01'); // already date-only
  });

  it('should handle missing optional fields', () => {
    const fm: NoteFrontmatter = { title: 'Minimal' };
    const row = frontmatterToRow(fm, '/min.md', 'workspace', 'hash');

    expect(row.status).toBeNull();
    expect(row.priority).toBeNull();
    expect(row.sort_order).toBeNull();
    expect(row.tags).toBeNull();
    expect(row.context).toBeNull();
  });
});

describe('reindex', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sync-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true });

    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should index all markdown files in a vault directory', async () => {
    fs.writeFileSync(
      path.join(vaultDir, 'inbox', 'task1.md'),
      '---\ntitle: Task One\ntype: task\nstatus: inbox\n---\nBody text.'
    );
    fs.writeFileSync(
      path.join(vaultDir, 'notes', 'note1.md'),
      '---\ntitle: My Note\ntype: note\n---\nNote body.'
    );

    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.inserted).toBe(2);
    expect(stats.deleted).toBe(0);

    const rows = db.all<NoteRow>('SELECT * FROM notes ORDER BY title');
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe('My Note');
    expect(rows[1].title).toBe('Task One');
  });

  it('should skip files that have not changed since last index', async () => {
    const filePath = path.join(vaultDir, 'inbox', 'task1.md');
    fs.writeFileSync(filePath, '---\ntitle: Old\ntype: task\nstatus: inbox\n---\n');

    await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);

    // Reindex without changing the file
    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it('should delete DB rows for files that no longer exist', async () => {
    const filePath = path.join(vaultDir, 'inbox', 'task1.md');
    fs.writeFileSync(filePath, '---\ntitle: Gone\ntype: task\nstatus: inbox\n---\n');

    await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(db.all('SELECT * FROM notes').length).toBe(1);

    // Delete file and reindex
    fs.unlinkSync(filePath);
    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.deleted).toBe(1);
    expect(db.all('SELECT * FROM notes').length).toBe(0);
  });

  it('should handle both global and workspace vaults', async () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'inbox'), { recursive: true });

    fs.writeFileSync(
      path.join(vaultDir, 'inbox', 'global-task.md'),
      '---\ntitle: Global\ntype: task\nstatus: inbox\n---\n'
    );
    fs.writeFileSync(
      path.join(wsDir, 'inbox', 'ws-task.md'),
      '---\ntitle: Workspace\ntype: task\nstatus: next\n---\n'
    );

    await reindex(db, [
      { rootDir: vaultDir, scope: 'global' },
      { rootDir: wsDir, scope: 'workspace' },
    ]);

    const rows = db.all<NoteRow>('SELECT * FROM notes ORDER BY title');
    expect(rows.length).toBe(2);
    expect(rows[0].scope).toBe('global');
    expect(rows[1].scope).toBe('workspace');
  });

  it('should skip hidden directories like .sessions', async () => {
    fs.mkdirSync(path.join(vaultDir, '.sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, '.sessions', '2026-04-01.jsonl'),
      '{"action":"create"}\n'
    );
    fs.writeFileSync(
      path.join(vaultDir, 'inbox', 'task.md'),
      '---\ntitle: Real Task\ntype: task\nstatus: inbox\n---\n'
    );

    const stats = await reindex(db, [{ rootDir: vaultDir, scope: 'global' }]);
    expect(stats.inserted).toBe(1); // Only the task, not the session log
  });
});
