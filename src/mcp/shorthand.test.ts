import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { upsertNote, NoteRow } from '../db/queries';
import { resolveShorthand, parseShorthand, STATUS_PREFIX } from './shorthand';

function makeTask(overrides: Partial<NoteRow>): NoteRow {
  return {
    path: '/test.md', scope: 'global', title: 'Test', type: 'task',
    status: 'inbox', priority: 'medium', sort_order: null, due: null,
    project: null, context: null, tags: null, recurrence: null,
    created: '2026-04-01', modified: '2026-04-01', body_hash: 'h',
    indexed_at: new Date().toISOString(), ...overrides,
  };
}

describe('parseShorthand', () => {
  it('should parse valid shorthands', () => {
    expect(parseShorthand('N1')).toEqual({ status: 'next', index: 1 });
    expect(parseShorthand('A3')).toEqual({ status: 'active', index: 3 });
    expect(parseShorthand('I10')).toEqual({ status: 'inbox', index: 10 });
    expect(parseShorthand('S2')).toEqual({ status: 'someday', index: 2 });
    expect(parseShorthand('W1')).toEqual({ status: 'waiting', index: 1 });
    expect(parseShorthand('D5')).toEqual({ status: 'done', index: 5 });
    expect(parseShorthand('C1')).toEqual({ status: 'cancelled', index: 1 });
  });

  it('should be case-insensitive', () => {
    expect(parseShorthand('n1')).toEqual({ status: 'next', index: 1 });
  });

  it('should return null for invalid shorthands', () => {
    expect(parseShorthand('X1')).toBeNull();
    expect(parseShorthand('N0')).toBeNull();
    expect(parseShorthand('N')).toBeNull();
    expect(parseShorthand('hello')).toBeNull();
    expect(parseShorthand('')).toBeNull();
  });
});

describe('resolveShorthand', () => {
  let tmpDir: string;
  let db: GroundworkDB;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-shorthand-'));
    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve N1 to the first next task by sort order', () => {
    upsertNote(db, makeTask({ path: '/a.md', status: 'next', title: 'Alpha', sort_order: 20 }));
    upsertNote(db, makeTask({ path: '/b.md', status: 'next', title: 'Beta', sort_order: 10 }));
    upsertNote(db, makeTask({ path: '/c.md', status: 'next', title: 'Gamma', sort_order: 30 }));

    expect(resolveShorthand(db, 'N1')).toBe('/b.md');  // sort_order 10 is first
    expect(resolveShorthand(db, 'N2')).toBe('/a.md');  // sort_order 20
    expect(resolveShorthand(db, 'N3')).toBe('/c.md');  // sort_order 30
  });

  it('should return null for out-of-range index', () => {
    upsertNote(db, makeTask({ path: '/a.md', status: 'next', title: 'Only' }));
    expect(resolveShorthand(db, 'N1')).toBe('/a.md');
    expect(resolveShorthand(db, 'N2')).toBeNull();
  });

  it('should sort by priority when sort_order is null', () => {
    upsertNote(db, makeTask({ path: '/low.md', status: 'inbox', title: 'Low', priority: 'low' }));
    upsertNote(db, makeTask({ path: '/high.md', status: 'inbox', title: 'High', priority: 'high' }));

    expect(resolveShorthand(db, 'I1')).toBe('/high.md');
    expect(resolveShorthand(db, 'I2')).toBe('/low.md');
  });

  it('should return null for invalid shorthand', () => {
    expect(resolveShorthand(db, 'X1')).toBeNull();
  });

  it('should pass through absolute paths', () => {
    expect(resolveShorthand(db, '/some/path.md')).toBe('/some/path.md');
  });
});
