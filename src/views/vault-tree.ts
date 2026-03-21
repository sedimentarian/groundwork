import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { VaultFile, VaultScope, ParsedNote, NoteFrontmatter } from '../vault/types';

const VAULT_MIME = 'application/vnd.groundwork.vault-file';

export interface VaultFilter {
  type?: string;    // note, reference, project, log
  tag?: string;
  search?: string;
}

/** A root node representing a vault scope */
class VaultRoot {
  readonly kind = 'vault-root' as const;
  constructor(
    public readonly scope: VaultScope,
    public readonly label: string,
    public readonly rootDir: string
  ) {}
}

class VaultFileItem {
  readonly kind = 'vault-file' as const;
  constructor(public readonly file: VaultFile) {}
}

type VaultTreeItem = VaultRoot | VaultFileItem;

export class VaultTreeProvider implements vscode.TreeDataProvider<VaultTreeItem>,
  vscode.TreeDragAndDropController<VaultTreeItem> {

  // Drag-and-drop support
  readonly dragMimeTypes = [VAULT_MIME];
  readonly dropMimeTypes = [VAULT_MIME];

  private _onDidChangeTreeData = new vscode.EventEmitter<VaultTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _filter: VaultFilter = {};

  /** Callback when a file is moved via drag-and-drop */
  onFileMoved?: (oldPath: string, newPath: string, detail: string) => void;

  constructor(private manager: VaultManager) {}

  // ── Filter state ─────────────────────────────────────────────────────────────

  get filter(): VaultFilter {
    return { ...this._filter };
  }

  get hasActiveFilter(): boolean {
    return !!(this._filter.type || this._filter.tag || this._filter.search);
  }

  setFilter(filter: VaultFilter): void {
    this._filter = { ...filter };
    this._onDidChangeTreeData.fire(undefined);
  }

  updateFilter(key: keyof VaultFilter, value: string | undefined): void {
    this._filter[key] = value;
    this._onDidChangeTreeData.fire(undefined);
  }

  clearFilter(): void {
    this._filter = {};
    this._onDidChangeTreeData.fire(undefined);
  }

  getFilterDescription(): string {
    const parts: string[] = [];
    if (this._filter.type) parts.push(`type: ${this._filter.type}`);
    if (this._filter.tag) parts.push(`tag: ${this._filter.tag}`);
    if (this._filter.search) parts.push(`"${this._filter.search}"`);
    return parts.join(' · ');
  }

  // ── Data helpers ─────────────────────────────────────────────────────────────

  /** Collect all unique tags across all non-task notes */
  async getAllTags(): Promise<string[]> {
    const allNotes = await this.manager.queryNotes({});
    const tagSet = new Set<string>();
    for (const note of allNotes) {
      if (note.frontmatter.type === 'task') continue;
      const tags = note.frontmatter.tags;
      if (Array.isArray(tags)) {
        for (const tag of tags) if (tag) tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  handleDrag(source: readonly VaultTreeItem[], dataTransfer: vscode.DataTransfer): void {
    // Only files can be dragged, not roots or directories.
    const files = source.filter((s): s is VaultFileItem => 'kind' in s && s.kind === 'vault-file' && !s.file.isDirectory);
    if (files.length === 0) return;
    dataTransfer.set(VAULT_MIME, new vscode.DataTransferItem(
      files.map(f => f.file.path)
    ));
  }

  async handleDrop(target: VaultTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(VAULT_MIME);
    if (!item) { return; }
    const draggedFiles: string[] = item.value;
    if (!draggedFiles || draggedFiles.length === 0) { return; }
    if (!target) { return; }

    // Determine target directory (root drops are intentionally disabled)
    let targetDir: string | undefined;
    let targetScope: VaultScope | undefined;
    let targetFolderHint: string | undefined;

    if ('kind' in target && target.kind === 'vault-file') {
      targetDir = target.file.isDirectory ? target.file.path : path.dirname(target.file.path);
      targetScope = target.file.source;
      if (target.file.isDirectory) {
        targetFolderHint = target.file.name;
      } else {
        targetFolderHint = path.basename(path.dirname(target.file.relativePath));
      }
    }

    if (!targetDir || !targetScope) return;

    for (const draggedPath of draggedFiles) {
      const fileName = path.basename(draggedPath);
      const newPath = path.join(targetDir, fileName);

      try {
        const sourceScope = this.manager.scopeOf(draggedPath);
        if (!sourceScope) continue;
        const targetStore = this.manager.storeFor(targetScope);
        if (!targetStore) continue;

        // Determine if the target folder implies a different note type
        const targetRoot = targetStore?.rootDir;
        const targetFolderName = targetFolderHint ?? topLevelFolderForPath(newPath, targetRoot);
        const impliedType = folderToNoteType(targetFolderName);

        // Always read the note first so we can update type even on same-path drops.
        const note = await this.manager.readNote(draggedPath);
        const oldType = note.frontmatter.type;
        const shouldRetype = !!impliedType && note.frontmatter.type !== impliedType;

        // VS Code can occasionally resolve a folder drop to the original path.
        // Still enforce folder-implied type in place when needed.
        if (draggedPath === newPath) {
          if (!shouldRetype) continue;
          note.frontmatter.type = impliedType as NoteFrontmatter['type'];
          note.frontmatter.modified = new Date().toISOString();
          await this.manager.writeNote(draggedPath, note.frontmatter, note.body);

          const detail = `retagged in place: ${oldType ?? 'unset'} → ${note.frontmatter.type}`;
          this.onFileMoved?.(draggedPath, draggedPath, detail);
          continue;
        }

        // Move to new path and apply folder-implied type.
        if (shouldRetype) {
          note.frontmatter.type = impliedType as NoteFrontmatter['type'];
        }

        // Prevent accidental overwrite on destination collision.
        const targetSlug = path.basename(fileName, path.extname(fileName));
        const targetExt = path.extname(fileName) || '.md';
        const destinationPath = await targetStore.findAvailablePath(targetDir, targetSlug, targetExt);

        note.frontmatter.modified = new Date().toISOString();
        await this.manager.writeNote(destinationPath, note.frontmatter, note.body);
        await this.manager.delete(draggedPath);

        const store = this.manager.storeFor(sourceScope);
        const detail = sourceScope === targetScope
          ? `moved to ${path.relative(store?.rootDir ?? '', targetDir)}`
          : `moved ${sourceScope} → ${targetScope}`;
        this.onFileMoved?.(draggedPath, destinationPath, detail);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to move file: ${message}`);
      }
    }

    // Double-refresh to defeat VS Code debouncing (same pattern as task tree)
    this.refresh();
    setTimeout(() => this.refresh(), 100);
  }

  // ── Tree data ──────────────────────────────────────────────────────────────

  getTreeItem(element: VaultTreeItem): vscode.TreeItem {
    if ('kind' in element && element.kind === 'vault-root') {
      const icon = element.scope === 'global' ? 'globe' : 'folder-library';
      const label = element.scope === 'global' ? '🌐 Global Vault' : '📂 Workspace Vault';
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(icon);
      item.contextValue = `vault-root-${element.scope}`;
      item.tooltip = `Root: ${element.rootDir}`;
      return item;
    }

    // VaultFile
    const file = element.file;
    const displayName = file.isDirectory
      ? file.name
      : (file.title ?? slugToTitle(file.name.replace(/\.md$/, '')));

    const dirState = vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(
      displayName,
      file.isDirectory
        ? dirState
        : vscode.TreeItemCollapsibleState.None
    );

    if (!file.isDirectory) {
      item.command = {
        command: 'groundwork.openEditor',
        title: 'Open in WYSIWYG Editor',
        arguments: [vscode.Uri.file(file.path)],
      };
      item.iconPath = new vscode.ThemeIcon(fileIcon(file));
      // Detect if file is in the archive/ directory
      const isArchived = file.relativePath.startsWith('archive' + path.sep) || file.relativePath.startsWith('archive/');
      const scope = file.source === 'workspace' ? 'workspace' : 'global';
      item.contextValue = isArchived ? `vault-file-archived-${scope}` : `vault-file-${scope}`;

      // Description: scope badge + type label
      const scopeEmoji = file.source === 'workspace' ? '📂' : '🌐';
      const typeLabel = file.noteType ? ` · ${file.noteType}` : '';
      item.description = `${scopeEmoji}${typeLabel}`;

      // Tooltip with full path
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`**${displayName}**\n\n`);
      md.appendMarkdown(`| | |\n|:---|:---|\n`);
      md.appendMarkdown(`| 📄 File | \`${file.relativePath}\` |\n`);
      md.appendMarkdown(`| 🌐 Scope | ${file.source === 'workspace' ? 'Workspace' : 'Global'} |\n`);
      if (file.noteType) md.appendMarkdown(`| 🏷 Type | ${file.noteType} |\n`);
      item.tooltip = md;

    } else {
      item.iconPath = new vscode.ThemeIcon(dirIcon(file.name));
      item.contextValue = 'vault-folder';
      item.tooltip = file.relativePath;

      // Show count of files inside
      const fileCount = countFiles(file);
      if (fileCount > 0) {
        item.description = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
      }
    }

    return item;
  }

  // getParent is required for treeView.reveal() to work (used by expand all)
  getParent(element: VaultTreeItem): VaultTreeItem | undefined {
    // Roots are top-level — no parent.
    // We only call reveal() on roots (for expand-all), so undefined is sufficient.
    return undefined;
  }

  async getChildren(element?: VaultTreeItem): Promise<VaultTreeItem[]> {
    if (!element) {
      // If any filter is active, return flat filtered results
      if (this.hasActiveFilter) {
        return this.getFilteredResults();
      }

      // Root level: show scope roots
      const roots: VaultTreeItem[] = [];
      if (this.manager.workspaceStore) {
        roots.push(new VaultRoot('workspace', '📂 Workspace', this.manager.workspacePath!));
      }
      roots.push(new VaultRoot('global', '🌐 Global', this.manager.globalPath));
      return roots;
    }

    if ('kind' in element && element.kind === 'vault-root') {
      const store = this.manager.storeFor(element.scope);
      if (!store) return [];
      try {
        const files = await store.listFiles();
        return filterVaultFiles(files).map(f => new VaultFileItem(f));
      } catch {
        return [];
      }
    }

    // VaultFile directory — return pre-populated (already filtered) children
    if ('kind' in element && element.kind === 'vault-file') {
      const dir = element.file;
      if (dir.isDirectory && dir.children) {
        return dir.children.map(c => new VaultFileItem(c));
      }
    }

    return [];
  }

  // ── Filter implementation ──────────────────────────────────────────────────

  private async getFilteredResults(): Promise<VaultTreeItem[]> {
    // Get all non-task notes from both vaults
    const allNotes = await this.manager.queryNotes({});
    let results = allNotes.filter(n => n.frontmatter.type !== 'task' &&
      !n.relativePath.startsWith('archive/') && !n.relativePath.startsWith('archive' + path.sep));

    // Apply type filter
    if (this._filter.type) {
      const filterType = this._filter.type;
      results = results.filter(n => n.frontmatter.type === filterType);
    }

    // Apply tag filter
    if (this._filter.tag) {
      const filterTag = this._filter.tag;
      results = results.filter(n => {
        const tags = n.frontmatter.tags;
        return Array.isArray(tags) && tags.includes(filterTag);
      });
    }

    // Apply search filter
    if (this._filter.search) {
      const query = this._filter.search.toLowerCase();
      results = results.filter(note => {
        const title = (note.frontmatter.title ?? '').toLowerCase();
        const body = note.body.toLowerCase();
        const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.join(' ').toLowerCase() : '';
        const type = (note.frontmatter.type ?? '').toLowerCase();
        const project = (note.frontmatter.project ?? '').toLowerCase();
        return title.includes(query) || body.includes(query) ||
               tags.includes(query) || type.includes(query) ||
               project.includes(query);
      });
    }

    // Convert to VaultFile items for display
    return results.map(note => new VaultFileItem({
      path: note.path,
      relativePath: note.relativePath,
      name: path.basename(note.path),
      isDirectory: false,
      source: note.source,
      title: note.frontmatter.title,
      noteType: note.frontmatter.type,
    } as VaultFile));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a slug filename to a readable title */
function slugToTitle(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Choose icon based on note type or directory context */
function fileIcon(file: VaultFile): string {
  const type = file.noteType;
  if (!type) {
    // Fall back to directory-based guess
    const dir = path.dirname(file.relativePath);
    if (dir === 'inbox') return 'circle-outline';
    if (dir === 'reference') return 'book';
    if (dir === 'projects') return 'project';
    if (dir === 'logs') return 'output';
    return 'file';
  }
  switch (type) {
    case 'task':      return 'checklist';
    case 'reference': return 'book';
    case 'note':      return 'note';
    case 'log':       return 'output';
    case 'project':   return 'project';
    default:          return 'file';
  }
}

/** Choose icon for well-known vault directories */
function dirIcon(name: string): string {
  switch (name) {
    case 'inbox':     return 'inbox';
    case 'projects':  return 'project';
    case 'reference': return 'book';
    case 'logs':      return 'output';
    case 'archive':   return 'archive';
    default:          return 'folder';
  }
}

/** Map well-known vault folder names to note types */
function folderToNoteType(folder: string): string | undefined {
  switch (folder.trim().toLowerCase()) {
    case 'inbox':     return 'task';
    case 'note':
    case 'notes':     return 'note';
    case 'references':
    case 'reference': return 'reference';
    case 'project':
    case 'projects':  return 'project';
    case 'log':
    case 'logs':      return 'log';
    default:          return undefined;
  }
}

/** Resolve the top-level folder for a note path under a vault root. */
function topLevelFolderForPath(filePath: string, vaultRoot?: string): string {
  if (!vaultRoot) return path.basename(path.dirname(filePath));

  const rel = path.relative(path.resolve(vaultRoot), path.resolve(filePath));
  // If paths are from different roots (or malformed), fall back to parent dir name.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.basename(path.dirname(filePath));
  }

  return rel.split(path.sep)[0] ?? path.basename(path.dirname(filePath));
}

/**
 * Remove task files from vault view — tasks belong exclusively in the Tasks panel.
 * Also prunes directories that become empty after filtering.
 */
function filterVaultFiles(files: VaultFile[]): VaultFile[] {
  const result: VaultFile[] = [];
  for (const file of files) {
    if (!file.isDirectory) {
      // Skip tasks — they live in the Tasks panel, not here
      if (file.noteType === 'task') continue;
      result.push(file);
    } else {
      // Recurse into directories, pruning empty ones
      const filteredChildren = filterVaultFiles(file.children ?? []);
      if (filteredChildren.length === 0) continue; // hide empty dirs
      result.push({ ...file, children: filteredChildren });
    }
  }
  return result;
}

/** Count non-directory descendants */
function countFiles(file: VaultFile): number {
  if (!file.children) return 0;
  let count = 0;
  for (const child of file.children) {
    if (!child.isDirectory) count++;
    else count += countFiles(child);
  }
  return count;
}
