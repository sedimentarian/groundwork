import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from './index';

describe('GroundworkDB', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-db-test-'));
    dbPath = path.join(tmpDir, '.index.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should open a new database when no file exists', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it('should persist and reload data across open/close', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    db.saveToDisk();
    db.close();

    // Reopen
    const db2 = new GroundworkDB(dbPath);
    await db2.open();
    const rows = db2.all<{ id: number; name: string }>('SELECT * FROM test');
    expect(rows).toEqual([{ id: 1, name: 'hello' }]);
    db2.close();
  });

  it('should create a fresh DB if file is missing', async () => {
    const db = new GroundworkDB(dbPath);
    await db.open();
    // Should not throw — creates fresh in-memory DB
    db.run('CREATE TABLE test (val TEXT)');
    expect(db.isOpen).toBe(true);
    db.close();
  });
});
