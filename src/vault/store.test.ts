import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, VaultStore } from './store';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------- parseFrontmatter ----------

describe('parseFrontmatter', () => {
  it('parses basic key-value pairs', () => {
    const raw = `---
title: My Task
type: task
status: inbox
priority: high
---
Body content here.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('My Task');
    expect(frontmatter.type).toBe('task');
    expect(frontmatter.status).toBe('inbox');
    expect(frontmatter.priority).toBe('high');
    expect(body).toBe('Body content here.');
  });

  it('parses inline arrays', () => {
    const raw = `---
tags: ["feature", "ux"]
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(['feature', 'ux']);
  });

  it('parses block arrays', () => {
    const raw = `---
tags:
  - feature
  - ux
  - backend
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(['feature', 'ux', 'backend']);
  });

  it('handles inline arrays with single quotes', () => {
    const raw = `---
context: ['@computer', '@phone']
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.context).toEqual(['@computer', '@phone']);
  });

  it('returns raw body when no frontmatter present', () => {
    const raw = 'Just some plain text without frontmatter.';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('handles empty body', () => {
    const raw = `---
title: Empty
---
`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('Empty');
    expect(body).toBe('');
  });

  it('handles multiline body with markdown', () => {
    const raw = `---
title: Complex
---
# Heading

Some **bold** text.

- List item 1
- List item 2`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('Complex');
    expect(body).toContain('# Heading');
    expect(body).toContain('- List item 1');
  });

  it('handles values with colons', () => {
    const raw = `---
title: Fix: login bug
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe('Fix: login bug');
  });

  it('handles dates as strings', () => {
    const raw = `---
created: 2026-03-17T12:00:00.000Z
due: 2026-03-20
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.created).toBe('2026-03-17T12:00:00.000Z');
    expect(frontmatter.due).toBe('2026-03-20');
  });

  it('handles mixed block and inline arrays', () => {
    const raw = `---
tags: ["inline"]
context:
  - "@computer"
  - "@phone"
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(['inline']);
    expect(frontmatter.context).toEqual(['@computer', '@phone']);
  });

  it('handles extra fields via [key: string]: unknown', () => {
    const raw = `---
title: Test
recurrence: every monday
recurrence-anchor: 2026-03-17
sort-order: 10
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter['recurrence']).toBe('every monday');
    expect(frontmatter['recurrence-anchor']).toBe('2026-03-17');
    expect(frontmatter['sort-order']).toBe('10');
  });
});

// ---------- serializeFrontmatter ----------

describe('serializeFrontmatter', () => {
  it('serializes basic fields', () => {
    const fm = { title: 'My Task', type: 'task' as const, status: 'inbox' as const };
    const result = serializeFrontmatter(fm);
    expect(result).toContain('---');
    expect(result).toContain('title: My Task');
    expect(result).toContain('type: task');
    expect(result).toContain('status: inbox');
  });

  it('serializes arrays as inline JSON-style', () => {
    const fm = { tags: ['feature', 'ux'] };
    const result = serializeFrontmatter(fm);
    expect(result).toContain('tags: ["feature", "ux"]');
  });

  it('skips undefined and null values', () => {
    const fm = { title: 'Test', due: undefined, priority: null as any };
    const result = serializeFrontmatter(fm);
    expect(result).toContain('title: Test');
    expect(result).not.toContain('due');
    expect(result).not.toContain('priority');
  });

  it('roundtrips through parse → serialize → parse', () => {
    const original = `---
title: Roundtrip Test
type: task
status: active
tags: ["bug", "urgent"]
project: MyApp
---
`;
    const { frontmatter } = parseFrontmatter(original);
    const serialized = serializeFrontmatter(frontmatter);
    const { frontmatter: reparsed } = parseFrontmatter(serialized + '\n');
    expect(reparsed.title).toBe('Roundtrip Test');
    expect(reparsed.type).toBe('task');
    expect(reparsed.status).toBe('active');
    expect(reparsed.tags).toEqual(['bug', 'urgent']);
    expect(reparsed.project).toBe('MyApp');
  });
});

// ---------- VaultStore file operations ----------

describe('VaultStore', () => {
  let tmpDir: string;
  let store: VaultStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'groundwork-test-'));
    store = new VaultStore(tmpDir, 'global');
    await store.init();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('init creates directory structure', async () => {
    const dirs = ['inbox', 'notes', 'projects', 'reference', 'logs', '.sessions'];
    for (const dir of dirs) {
      const stat = await fs.promises.stat(path.join(tmpDir, dir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('writeNote and readNote roundtrip', async () => {
    const filePath = path.join(tmpDir, 'inbox', 'test-task.md');
    const fm = { title: 'Test Task', type: 'task' as const, status: 'inbox' as const, created: '2026-03-17T12:00:00.000Z' };
    const body = '\nThis is the body.\n';

    await store.writeNote(filePath, fm, body);
    const note = await store.readNote(filePath);

    expect(note.frontmatter.title).toBe('Test Task');
    expect(note.frontmatter.type).toBe('task');
    expect(note.body).toContain('This is the body.');
    expect(note.source).toBe('global');
  });

  it('findAvailablePath returns base path when no conflict', async () => {
    const result = await store.findAvailablePath(path.join(tmpDir, 'inbox'), 'new-task');
    expect(result).toBe(path.join(tmpDir, 'inbox', 'new-task.md'));
  });

  it('findAvailablePath appends number when file exists', async () => {
    const existing = path.join(tmpDir, 'inbox', 'existing.md');
    await fs.promises.writeFile(existing, '---\ntitle: Existing\n---\n');

    const result = await store.findAvailablePath(path.join(tmpDir, 'inbox'), 'existing');
    expect(result).toBe(path.join(tmpDir, 'inbox', 'existing-2.md'));
  });

  it('findAvailablePath increments until free', async () => {
    const dir = path.join(tmpDir, 'inbox');
    await fs.promises.writeFile(path.join(dir, 'dup.md'), 'x');
    await fs.promises.writeFile(path.join(dir, 'dup-2.md'), 'x');
    await fs.promises.writeFile(path.join(dir, 'dup-3.md'), 'x');

    const result = await store.findAvailablePath(dir, 'dup');
    expect(result).toBe(path.join(dir, 'dup-4.md'));
  });

  it('delete removes a file', async () => {
    const filePath = path.join(tmpDir, 'inbox', 'to-delete.md');
    await fs.promises.writeFile(filePath, '---\ntitle: Delete me\n---\n');

    await store.delete(filePath);
    await expect(fs.promises.access(filePath)).rejects.toThrow();
  });

  it('assertWithinVault blocks path traversal', async () => {
    const evilPath = path.join(tmpDir, '..', 'etc', 'passwd');
    await expect(store.readNote(evilPath)).rejects.toThrow(/Path traversal denied/);
  });

  it('queryNotes filters by frontmatter', async () => {
    const task1 = path.join(tmpDir, 'inbox', 'task1.md');
    const task2 = path.join(tmpDir, 'inbox', 'task2.md');
    const note = path.join(tmpDir, 'notes', 'note1.md');

    await store.writeNote(task1, { title: 'Task 1', type: 'task', status: 'active', created: '2026-03-01T00:00:00Z' }, '\n');
    await store.writeNote(task2, { title: 'Task 2', type: 'task', status: 'done', created: '2026-03-01T00:00:00Z' }, '\n');
    await store.writeNote(note, { title: 'Note 1', type: 'note', created: '2026-03-01T00:00:00Z' }, '\n');

    const activeTasks = await store.queryNotes({ type: 'task', status: 'active' });
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0].frontmatter.title).toBe('Task 1');
  });

  it('listFiles returns vault contents', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'inbox', 'a.md'), '---\ntitle: A\ntype: task\n---\n');
    await fs.promises.writeFile(path.join(tmpDir, 'notes', 'b.md'), '---\ntitle: B\ntype: note\n---\n');

    const files = await store.listFiles();
    const allNames = flattenNames(files);
    expect(allNames).toContain('a.md');
    expect(allNames).toContain('b.md');
  });

  it('listFiles skips dot-directories', async () => {
    const files = await store.listFiles();
    const allNames = flattenNames(files);
    expect(allNames).not.toContain('.sessions');
  });

  it('rename moves a file', async () => {
    const oldPath = path.join(tmpDir, 'inbox', 'old.md');
    const newPath = path.join(tmpDir, 'notes', 'new.md');
    await fs.promises.writeFile(oldPath, '---\ntitle: Old\n---\n');

    await store.rename(oldPath, newPath);

    await expect(fs.promises.access(oldPath)).rejects.toThrow();
    const content = await fs.promises.readFile(newPath, 'utf-8');
    expect(content).toContain('title: Old');
  });

  it('logSession writes JSONL entry', async () => {
    await store.logSession({
      timestamp: '2026-03-17T12:00:00.000Z',
      action: 'create',
      file: 'inbox/test.md',
    });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, '.sessions', `${today}.jsonl`);
    const content = await fs.promises.readFile(logFile, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.action).toBe('create');
    expect(entry.file).toBe('inbox/test.md');
  });
});

function flattenNames(files: { name: string; children?: any[] }[]): string[] {
  const names: string[] = [];
  for (const f of files) {
    names.push(f.name);
    if (f.children) names.push(...flattenNames(f.children));
  }
  return names;
}
