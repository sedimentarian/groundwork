import * as fs from 'fs';
import * as path from 'path';
import { VaultFile, ParsedNote, NoteFrontmatter, SessionEntry, VaultScope } from './types';

export class VaultStore {
  constructor(public rootDir: string, public readonly scope: VaultScope = 'global') {}

  /** Ensure vault directory and default structure exist */
  async init(): Promise<void> {
    const dirs = [
      this.rootDir,
      path.join(this.rootDir, 'inbox'),
      path.join(this.rootDir, 'notes'),
      path.join(this.rootDir, 'projects'),
      path.join(this.rootDir, 'reference'),
      path.join(this.rootDir, 'logs'),
      path.join(this.rootDir, '.sessions'),
    ];
    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /** List vault contents recursively */
  async listFiles(dir?: string): Promise<VaultFile[]> {
    const target = dir ?? this.rootDir;
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const results: VaultFile[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(target, entry.name);
      const relativePath = path.relative(this.rootDir, fullPath);

      if (entry.isDirectory()) {
        const children = await this.listFiles(fullPath);
        results.push({
          path: fullPath,
          relativePath,
          name: entry.name,
          isDirectory: true,
          children,
          source: this.scope,
        });
      } else if (entry.name.endsWith('.md')) {
        const meta = await this.quickReadMeta(fullPath);
        results.push({
          path: fullPath,
          relativePath,
          name: entry.name,
          isDirectory: false,
          source: this.scope,
          title: meta.title,
          noteType: meta.type,
        });
      }
    }

    // Directories first, then files, alphabetical within each group
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  /** Read just enough of a file to extract title and type from frontmatter */
  private async quickReadMeta(filePath: string): Promise<{ title?: string; type?: string }> {
    try {
      const fd = await fs.promises.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(1024);
        const { bytesRead } = await fd.read(buf, 0, 1024, 0);
        const snippet = buf.slice(0, bytesRead).toString('utf-8');
        const { frontmatter } = parseFrontmatter(snippet);
        return { title: frontmatter.title, type: frontmatter.type };
      } finally {
        await fd.close();
      }
    } catch {
      return {};
    }
  }

  /** Read and parse a markdown file with frontmatter */
  async readNote(filePath: string): Promise<ParsedNote> {
    this.assertWithinVault(filePath);
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      path: filePath,
      relativePath: path.relative(this.rootDir, filePath),
      frontmatter,
      body,
      raw,
      source: this.scope,
    };
  }

  /** Write a markdown file with frontmatter */
  async writeNote(filePath: string, frontmatter: NoteFrontmatter, body: string): Promise<void> {
    this.assertWithinVault(filePath);
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Canonicalize note type from the top-level folder when known.
    // This guarantees folder moves (e.g. notes -> reference) persist matching type.
    const impliedType = noteTypeFromVaultPath(filePath, this.rootDir);
    if (impliedType) {
      frontmatter.type = impliedType;
    }

    frontmatter.modified = new Date().toISOString();
    const content = serializeFrontmatter(frontmatter) + body;
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  /** Get all notes matching a filter */
  async queryNotes(filter: Partial<NoteFrontmatter>): Promise<ParsedNote[]> {
    const allFiles = await this.collectMarkdownFiles(this.rootDir);
    const results: ParsedNote[] = [];

    for (const filePath of allFiles) {
      const note = await this.readNote(filePath);
      if (matchesFilter(note.frontmatter, filter)) {
        results.push(note);
      }
    }
    return results;
  }

  /** Log a session entry */
  async logSession(entry: SessionEntry): Promise<void> {
    const logFile = path.join(
      this.rootDir,
      '.sessions',
      `${new Date().toISOString().slice(0, 10)}.jsonl`
    );
    const line = JSON.stringify(entry) + '\n';
    await fs.promises.appendFile(logFile, line, 'utf-8');
  }

  /** Read recent session entries */
  async getRecentSessions(days: number = 7): Promise<SessionEntry[]> {
    const sessionsDir = path.join(this.rootDir, '.sessions');
    const entries: SessionEntry[] = [];

    try {
      const files = await fs.promises.readdir(sessionsDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      for (const file of files.filter(f => f.endsWith('.jsonl')).sort().reverse()) {
        const dateStr = file.replace('.jsonl', '');
        if (dateStr < cutoff.toISOString().slice(0, 10)) break;

        const content = await fs.promises.readFile(path.join(sessionsDir, file), 'utf-8');
        for (const line of content.trim().split('\n').filter(Boolean)) {
          entries.push(JSON.parse(line));
        }
      }
    } catch {
      // No sessions yet
    }

    return entries.reverse();
  }

  /** Delete a file */
  async delete(filePath: string): Promise<void> {
    this.assertWithinVault(filePath);
    await fs.promises.unlink(filePath);
  }

  /** Return a path that doesn't exist yet, appending -2, -3 etc. if needed */
  async findAvailablePath(dir: string, slug: string, ext = '.md'): Promise<string> {
    let candidate = path.join(dir, `${slug}${ext}`);
    let i = 2;
    while (true) {
      try {
        await fs.promises.access(candidate);
        candidate = path.join(dir, `${slug}-${i}${ext}`);
        i++;
      } catch {
        return candidate; // access threw → file doesn't exist
      }
    }
  }

  /** Rename/move a file within the vault */
  async rename(oldPath: string, newPath: string): Promise<void> {
    this.assertWithinVault(oldPath);
    this.assertWithinVault(newPath);
    const dir = path.dirname(newPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.rename(oldPath, newPath);
  }

  private assertWithinVault(filePath: string): void {
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.rootDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Path traversal denied: ${filePath}`);
    }
  }

  private async collectMarkdownFiles(dir: string, opts?: { includeArchive?: boolean }): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // Skip archive/ unless explicitly requested
      if (entry.name === 'archive' && dir === this.rootDir && !opts?.includeArchive) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await this.collectMarkdownFiles(fullPath, opts));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }
}

/** Parse YAML-like frontmatter from markdown — handles inline [a, b] and block (- item) arrays */
export function parseFrontmatter(raw: string): { frontmatter: NoteFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatter: NoteFrontmatter = {};
  const lines = match[1].split('\n');

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  const flushArray = () => {
    if (currentKey !== null && currentArray !== null) {
      (frontmatter as Record<string, unknown>)[currentKey] = currentArray;
    }
    currentKey = null;
    currentArray = null;
  };

  for (const line of lines) {
    // YAML block-sequence item: '  - value' (leading whitespace, dash, space)
    const arrayItem = line.match(/^\s+-\s+(.*)/);
    if (arrayItem && currentKey !== null) {
      currentArray!.push(arrayItem[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // A new key-value pair — flush any pending array first
    flushArray();

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const raw_val = line.slice(colonIdx + 1).trim();

    if (raw_val === '') {
      // Empty value — might be start of a block array
      currentKey = key;
      currentArray = [];
    } else if (raw_val.startsWith('[') && raw_val.endsWith(']')) {
      // Inline array: [item1, item2]
      const items = raw_val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      (frontmatter as Record<string, unknown>)[key] = items;
    } else {
      // Coerce numeric-looking values to numbers (e.g., sort-order: 10)
      const num = Number(raw_val);
      (frontmatter as Record<string, unknown>)[key] = raw_val !== '' && !isNaN(num) && String(num) === raw_val
        ? num
        : raw_val;
    }
  }

  flushArray();
  return { frontmatter, body: match[2] };
}

/** Serialize frontmatter back to YAML */
export function serializeFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => `"${v}"`).join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---', '');
  return lines.join('\n');
}

/** Check if frontmatter matches a filter */
function matchesFilter(fm: NoteFrontmatter, filter: Partial<NoteFrontmatter>): boolean {
  for (const [key, filterValue] of Object.entries(filter)) {
    if (filterValue === undefined) continue;
    const actual = (fm as Record<string, unknown>)[key];

    if (Array.isArray(filterValue)) {
      if (!Array.isArray(actual)) return false;
      if (!filterValue.some(v => actual.includes(v))) return false;
    } else if (actual !== filterValue) {
      return false;
    }
  }
  return true;
}

/** Infer canonical note type from a file's top-level folder under a vault root. */
function noteTypeFromVaultPath(filePath: string, rootDir: string): NoteFrontmatter['type'] | undefined {
  const rel = path.relative(path.resolve(rootDir), path.resolve(filePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;

  const top = (rel.split(path.sep)[0] ?? '').toLowerCase();
  switch (top) {
    case 'inbox':
      return 'task';
    case 'notes':
    case 'note':
      return 'note';
    case 'reference':
    case 'references':
      return 'reference';
    case 'projects':
    case 'project':
      return 'project';
    case 'logs':
    case 'log':
      return 'log';
    default:
      return undefined;
  }
}
