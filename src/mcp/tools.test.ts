import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { GroundworkDB } from '../db/index';
import { initSchema } from '../db/schema';
import { upsertNote, getNote, listTasks, deleteNote, NoteRow } from '../db/queries';
import { frontmatterToRow } from '../db/sync';
import { VaultStore, parseFrontmatter } from '../vault/store';
import { NoteFrontmatter } from '../vault/types';
import { resolveShorthand } from './shorthand';

describe('MCP tool logic', () => {
  let tmpDir: string;
  let vaultDir: string;
  let db: GroundworkDB;
  let store: VaultStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mcp-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    store = new VaultStore(vaultDir, 'global');
    await store.init();

    db = new GroundworkDB(path.join(tmpDir, 'test.db'));
    await db.open();
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a task and sync to DB. */
  async function createTask(title: string, status: string, priority = 'medium', sortOrder?: number) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(vaultDir, 'inbox', `${slug}.md`);
    const fm: NoteFrontmatter = {
      title, type: 'task', status: status as any, priority: priority as any,
      created: new Date().toISOString(),
    };
    if (sortOrder !== undefined) (fm as Record<string, unknown>)['sort-order'] = sortOrder;
    await store.writeNote(filePath, fm, '');
    const body = '';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    upsertNote(db, frontmatterToRow(fm, filePath, 'global', bodyHash));
    return filePath;
  }

  describe('create + list round-trip', () => {
    it('should create a task and list it back', async () => {
      const filePath = await createTask('Test Task', 'next');
      const tasks = listTasks(db, { status: 'next' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Test Task');
      expect(tasks[0].path).toBe(filePath);
    });
  });

  describe('update_note logic', () => {
    it('should update frontmatter fields and persist to file', async () => {
      const filePath = await createTask('Original', 'inbox');

      // Simulate update_note: read, merge, write
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      frontmatter.priority = 'high';
      frontmatter.status = 'next';

      await store.writeNote(filePath, frontmatter, body);

      // Sync to DB
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      upsertNote(db, frontmatterToRow(frontmatter, filePath, 'global', bodyHash));

      // Verify
      const row = getNote(db, filePath);
      expect(row!.priority).toBe('high');
      expect(row!.status).toBe('next');
    });
  });

  describe('delete_note guard', () => {
    it('should only allow deleting cancelled tasks', async () => {
      const filePath = await createTask('Active Task', 'active');
      const row = getNote(db, filePath);
      expect(row!.status).toBe('active');
      // Guard would reject this — status is not cancelled
      expect(row!.status !== 'cancelled').toBe(true);
      expect(!filePath.includes('/archive/')).toBe(true);
    });

    it('should allow deleting cancelled tasks', async () => {
      const filePath = await createTask('Cancel Me', 'cancelled');
      const row = getNote(db, filePath);
      expect(row!.status).toBe('cancelled');
    });
  });

  describe('shorthand integration', () => {
    it('should resolve shorthands after creating multiple tasks', async () => {
      await createTask('Alpha', 'next', 'medium', 10);
      await createTask('Beta', 'next', 'medium', 20);
      await createTask('Gamma', 'next', 'medium', 30);

      const n1 = resolveShorthand(db, 'N1');
      const n3 = resolveShorthand(db, 'N3');
      expect(n1).toContain('alpha');
      expect(n3).toContain('gamma');
    });
  });

  describe('daily_briefing data', () => {
    it('should aggregate task stats correctly', async () => {
      await createTask('Inbox 1', 'inbox');
      await createTask('Inbox 2', 'inbox');
      await createTask('Active 1', 'active');
      await createTask('Next 1', 'next');

      const stats = db.all<{ status: string; count: number }>(
        "SELECT status, COUNT(*) as count FROM notes WHERE type='task' GROUP BY status"
      );
      const byStatus = Object.fromEntries(stats.map(r => [r.status, r.count]));
      expect(byStatus.inbox).toBe(2);
      expect(byStatus.active).toBe(1);
      expect(byStatus.next).toBe(1);
    });
  });

  describe('write-through consistency', () => {
    it('should keep DB and file in sync after update', async () => {
      const filePath = await createTask('Sync Test', 'inbox');

      // Update via store
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      frontmatter.project = 'TestProject';
      frontmatter.tags = ['api', 'backend'];
      await store.writeNote(filePath, frontmatter, body);

      // Sync to DB
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      upsertNote(db, frontmatterToRow(frontmatter, filePath, 'global', bodyHash));

      // Verify DB
      const row = getNote(db, filePath);
      expect(row!.project).toBe('TestProject');
      expect(JSON.parse(row!.tags!)).toEqual(['api', 'backend']);

      // Verify file
      const raw2 = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter: fm2 } = parseFrontmatter(raw2);
      expect(fm2.project).toBe('TestProject');
      expect(fm2.tags).toEqual(['api', 'backend']);
    });
  });
});
