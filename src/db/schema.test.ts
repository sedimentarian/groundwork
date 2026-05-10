import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';
import { initSchema, SCHEMA_VERSION } from './schema';

describe('schema', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-schema-test-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create notes table with all expected columns', () => {
    initSchema(db);

    // Insert a row to verify columns exist
    db.run(
      `INSERT INTO notes (path, scope, title, type, status, priority, sort_order, due, project, context, tags, recurrence, created, modified, body_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['/test.md', 'global', 'Test', 'task', 'inbox', 'high', 10, '2026-04-01', 'MyProject', '["@computer"]', '["api"]', 'daily', '2026-04-01', '2026-04-01', 'abc123', new Date().toISOString()]
    );

    const row = db.get<Record<string, unknown>>('SELECT * FROM notes WHERE path = ?', ['/test.md']);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Test');
    expect(row!.sort_order).toBe(10);
    expect(row!.scope).toBe('global');
  });

  it('should create meta table with schema version', () => {
    initSchema(db);

    const meta = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    expect(meta).not.toBeNull();
    expect(meta!.value).toBe(String(SCHEMA_VERSION));
  });

  it('should create FTS5 virtual table with bm25 ranking', () => {
    initSchema(db);

    db.run(
      `INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)`,
      ['/fts-test.md', 'Search Me', 'Some body content']
    );

    // bm25() is FTS5-only — this would throw on FTS4
    const results = db.all<{ path: string }>(
      'SELECT path FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts)',
      ['Search']
    );
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('/fts-test.md');
  });

  it('should rebuild schema if version mismatches', () => {
    initSchema(db);

    // Simulate old schema version
    db.run("UPDATE meta SET value = '0' WHERE key = 'schema_version'");

    // Re-init should drop and rebuild
    initSchema(db);

    const meta = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    expect(meta!.value).toBe(String(SCHEMA_VERSION));
  });
});
