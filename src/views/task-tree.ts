import * as vscode from 'vscode';
import { VaultManager } from '../vault/manager';
import { ParsedNote, TaskStatus, GTD_LISTS } from '../vault/types';

export interface TaskFilter {
  tag?: string;
  context?: string;
  project?: string;
  search?: string;
}

type TaskTreeItem = TaskGroup | TaskItem;

class TaskGroup {
  constructor(public status: TaskStatus, public tasks: ParsedNote[]) {}
}

export class TaskItem {
  constructor(public note: ParsedNote) {}
}

const TASK_MIME = 'application/vnd.groundwork.task';

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem>,
  vscode.TreeDragAndDropController<TaskTreeItem> {

  // Drag-and-drop support
  readonly dragMimeTypes = [TASK_MIME];
  readonly dropMimeTypes = [TASK_MIME];

  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: Map<TaskStatus, ParsedNote[]> = new Map();
  private _filter: TaskFilter = {};
  private _dragInProgress = false;

  /** Callback invoked when a drop changes a task — lets extension.ts log + refresh */
  onTaskDropped?: (filePath: string, detail: string) => void;

  constructor(private manager: VaultManager) {}

  // ── Filter state ───────────────────────────────────────────────────────────

  get filter(): TaskFilter {
    return { ...this._filter };
  }

  get hasActiveFilter(): boolean {
    return !!(this._filter.tag || this._filter.context || this._filter.project || this._filter.search);
  }

  /** Backward compat */
  get activeTagFilter(): string | undefined {
    return this._filter.tag;
  }

  setFilter(filter: TaskFilter): void {
    this._filter = { ...filter };
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Update a single filter dimension, preserving others */
  updateFilter(key: keyof TaskFilter, value: string | undefined): void {
    this._filter[key] = value;
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Backward compat */
  setTagFilter(tag: string | undefined): void {
    this.updateFilter('tag', tag);
  }

  clearFilter(): void {
    this._filter = {};
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Human-readable description of active filters */
  getFilterDescription(): string {
    const parts: string[] = [];
    if (this._filter.tag) parts.push(`tag: ${this._filter.tag}`);
    if (this._filter.context) parts.push(`context: ${this._filter.context}`);
    if (this._filter.project) parts.push(`project: ${this._filter.project}`);
    if (this._filter.search) parts.push(`"${this._filter.search}"`);
    return parts.join(' · ');
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── Data helpers ───────────────────────────────────────────────────────────

  /** Collect all unique tags across all tasks */
  async getAllTags(): Promise<string[]> {
    const allTasks = await this.manager.queryNotes({ type: 'task' });
    const tagSet = new Set<string>();
    for (const task of allTasks) {
      const tags = task.frontmatter.tags;
      if (Array.isArray(tags)) {
        for (const tag of tags) tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  }

  /** Collect all unique GTD contexts across all tasks */
  async getAllContexts(): Promise<string[]> {
    const allTasks = await this.manager.queryNotes({ type: 'task' });
    const ctxSet = new Set<string>();
    for (const task of allTasks) {
      const contexts = task.frontmatter.context;
      if (Array.isArray(contexts)) {
        for (const c of contexts) ctxSet.add(c);
      }
    }
    return [...ctxSet].sort();
  }

  /** Collect all unique projects across all tasks */
  async getAllProjects(): Promise<string[]> {
    const allTasks = await this.manager.queryNotes({ type: 'task' });
    const projSet = new Set<string>();
    for (const task of allTasks) {
      const project = task.frontmatter.project;
      if (project && typeof project === 'string') {
        projSet.add(project);
      }
    }
    return [...projSet].sort();
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  handleDrag(source: readonly TaskTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
    // Only task items can be dragged, not group headers
    const taskItems = source.filter((s): s is TaskItem => s instanceof TaskItem);
    if (taskItems.length === 0) return;
    dataTransfer.set(TASK_MIME, new vscode.DataTransferItem(
      taskItems.map(t => t.note.path)
    ));

    // Show all groups (including empty ones) as drop targets while dragging
    this._dragInProgress = true;
    this._onDidChangeTreeData.fire(undefined);

    // When drag is cancelled (escape, drop outside), hide empty groups again
    token.onCancellationRequested(() => {
      this._dragInProgress = false;
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  async handleDrop(target: TaskTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    this._dragInProgress = false;

    const item = dataTransfer.get(TASK_MIME);
    if (!item) return;
    const draggedPaths: string[] = item.value;
    if (!draggedPaths || draggedPaths.length === 0) return;

    if (!target) return;

    // ── Drop on a group header → change status ──
    if (target instanceof TaskGroup) {
      const newStatus = target.status;
      for (const filePath of draggedPaths) {
        const note = await this.manager.readNote(filePath);
        const oldStatus = note.frontmatter.status ?? 'inbox';
        if (oldStatus === newStatus) continue;
        note.frontmatter.status = newStatus;
        note.frontmatter.modified = new Date().toISOString();
        await this.manager.writeNote(filePath, note.frontmatter, note.body);
        this.onTaskDropped?.(filePath, `${oldStatus} → ${newStatus}`);
      }
      this.refresh();
      return;
    }

    // ── Drop on a task item → reorder within the same group ──
    if (target instanceof TaskItem) {
      const targetStatus = (target.note.frontmatter.status as TaskStatus) ?? 'inbox';
      const groupTasks = this.cache.get(targetStatus);
      if (!groupTasks) return;

      // Only reorder tasks that share the same status group as the target
      const validPaths = new Set<string>();
      for (const dp of draggedPaths) {
        const note = await this.manager.readNote(dp);
        const dpStatus = (note.frontmatter.status as TaskStatus) ?? 'inbox';
        if (dpStatus === targetStatus) {
          validPaths.add(dp);
        } else {
          // Different group — treat as a status change instead
          note.frontmatter.status = targetStatus;
          note.frontmatter.modified = new Date().toISOString();
          await this.manager.writeNote(dp, note.frontmatter, note.body);
          this.onTaskDropped?.(dp, `${dpStatus} → ${targetStatus}`);
          validPaths.add(dp);
        }
      }

      // Build the new order: remove dragged items, insert before target
      const ordered = groupTasks.filter(t => !validPaths.has(t.path));
      const targetIdx = ordered.findIndex(t => t.path === target.note.path);
      const insertIdx = targetIdx >= 0 ? targetIdx : ordered.length;

      // Read fresh copies of dragged tasks
      const draggedNotes: ParsedNote[] = [];
      for (const dp of draggedPaths) {
        if (validPaths.has(dp)) {
          draggedNotes.push(await this.manager.readNote(dp));
        }
      }
      ordered.splice(insertIdx, 0, ...draggedNotes);

      // Write sort-order to frontmatter (10, 20, 30… — gaps for future manual inserts)
      for (let i = 0; i < ordered.length; i++) {
        const note = ordered[i];
        const newOrder = (i + 1) * 10;
        const currentOrder = note.frontmatter['sort-order'];
        if (currentOrder !== newOrder) {
          note.frontmatter['sort-order'] = newOrder;
          note.frontmatter.modified = new Date().toISOString();
          await this.manager.writeNote(note.path, note.frontmatter, note.body);
        }
      }

      this.refresh();
    }
  }

  // ── Tree data ──────────────────────────────────────────────────────────────

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element instanceof TaskGroup) {
      const count = element.tasks.length;
      const label = `${GTD_LISTS[element.status]} (${count})`;
      // Expand groups with tasks, collapse empty ones (they're still visible as drop targets)
      const state = count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(label, state);
      item.iconPath = new vscode.ThemeIcon(statusIcon(element.status));
      item.contextValue = 'task-group';
      return item;
    }

    const note = element.note;
    const title = note.frontmatter.title ?? note.relativePath;
    const isDone = note.frontmatter.status === 'done' || note.frontmatter.status === 'cancelled';
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);

    // Native checkbox — checked = done, unchecked = open
    item.checkboxState = isDone
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    // Click label opens in WYSIWYG editor
    item.command = {
      command: 'groundwork.openEditor',
      title: 'Open Task',
      arguments: [vscode.Uri.file(note.path)],
    };

    // Description: scope emoji (learned shorthand, full word in tooltip) + contexts
    const scopeEmoji = note.source === 'workspace' ? '📂' : '🌐';
    const contexts = note.frontmatter.context;
    const contextStr = contexts && Array.isArray(contexts) && contexts.length > 0
      ? contexts.join(', ')
      : '';
    item.description = contextStr ? `${scopeEmoji} ${contextStr}` : scopeEmoji;

    // 3-state attention signal — red/amber/neutral/done/cancelled
    if (note.frontmatter.status === 'cancelled') {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('disabledForeground'));
    } else if (isDone) {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      const urgency = dueUrgency(note.frontmatter.due);
      const priority = note.frontmatter.priority ?? 'medium';
      if (urgency === 'overdue' || priority === 'high') {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground'));
      } else if (urgency === 'soon') {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('editorWarning.foreground'));
      } else if (priority === 'low') {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('editorInfo.foreground'));
      } else {
        item.iconPath = new vscode.ThemeIcon('circle-filled');
      }
    }

    // contextValue encodes scope so move-to-global/move-to-workspace menus show correctly
    item.contextValue = note.source === 'workspace' ? 'task-item-workspace' : 'task-item-global';

    // Rich tooltip — metadata table + body preview
    item.tooltip = buildTooltip(note, title, contextStr);

    return item;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      let allTasks = await this.manager.queryNotes({ type: 'task' });

      // Apply all active filters
      allTasks = applyFilters(allTasks, this._filter);

      this.cache.clear();
      for (const task of allTasks) {
        const status = (task.frontmatter.status as TaskStatus) ?? 'inbox';
        if (!this.cache.has(status)) this.cache.set(status, []);
        this.cache.get(status)!.push(task);
      }

      // Sort tasks within each group by sort-order, then priority, then title
      for (const [, tasks] of this.cache) {
        tasks.sort(sortTasks);
      }

      const order: TaskStatus[] = ['inbox', 'next', 'active', 'waiting', 'someday', 'done', 'cancelled'];
      if (this._dragInProgress) {
        // Show all groups (including empty) as drop targets during drag
        return order.map(s => new TaskGroup(s, this.cache.get(s) ?? []));
      }
      // Normally, hide empty groups
      return order
        .filter(s => this.cache.has(s) && this.cache.get(s)!.length > 0)
        .map(s => new TaskGroup(s, this.cache.get(s)!));
    }

    if (element instanceof TaskGroup) {
      return element.tasks.map(t => new TaskItem(t));
    }

    return [];
  }
}

// ── Sorting ──────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortTasks(a: ParsedNote, b: ParsedNote): number {
  // First: sort-order (if both have it)
  const aOrder = typeof a.frontmatter['sort-order'] === 'number' ? a.frontmatter['sort-order'] as number : Infinity;
  const bOrder = typeof b.frontmatter['sort-order'] === 'number' ? b.frontmatter['sort-order'] as number : Infinity;
  if (aOrder !== bOrder) return aOrder - bOrder;

  // Then: priority (high first)
  const aPri = PRIORITY_RANK[a.frontmatter.priority ?? 'medium'] ?? 1;
  const bPri = PRIORITY_RANK[b.frontmatter.priority ?? 'medium'] ?? 1;
  if (aPri !== bPri) return aPri - bPri;

  // Then: title alphabetically
  const aTitle = (a.frontmatter.title ?? '').toLowerCase();
  const bTitle = (b.frontmatter.title ?? '').toLowerCase();
  return aTitle.localeCompare(bTitle);
}

// ── Filter logic ─────────────────────────────────────────────────────────────

function applyFilters(tasks: ParsedNote[], filter: TaskFilter): ParsedNote[] {
  let result = tasks;

  if (filter.tag) {
    const tag = filter.tag;
    result = result.filter(t => {
      const tags = t.frontmatter.tags;
      return Array.isArray(tags) && tags.includes(tag);
    });
  }

  if (filter.context) {
    const ctx = filter.context;
    result = result.filter(t => {
      const contexts = t.frontmatter.context;
      return Array.isArray(contexts) && contexts.includes(ctx);
    });
  }

  if (filter.project) {
    const proj = filter.project;
    result = result.filter(t => t.frontmatter.project === proj);
  }

  if (filter.search) {
    const query = filter.search.toLowerCase();
    result = result.filter(t => {
      const title = (t.frontmatter.title ?? '').toLowerCase();
      const body = t.body.toLowerCase();
      const project = (t.frontmatter.project ?? '').toLowerCase();
      const tags = Array.isArray(t.frontmatter.tags) ? t.frontmatter.tags.join(' ').toLowerCase() : '';
      return title.includes(query) || body.includes(query) || project.includes(query) || tags.includes(query);
    });
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'inbox':     return 'inbox';
    case 'next':      return 'arrow-right';
    case 'active':    return 'play';
    case 'waiting':   return 'clock';
    case 'someday':   return 'cloud';
    case 'done':      return 'check';
    case 'cancelled': return 'close';
    default:          return 'question';
  }
}

function dueUrgency(dueStr?: string): 'overdue' | 'soon' | 'normal' {
  if (!dueStr) return 'normal';
  const due = new Date(dueStr);
  if (isNaN(due.getTime())) return 'normal';
  const diffDays = (due.getTime() - Date.now()) / 86_400_000;
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 3) return 'soon';
  return 'normal';
}

function buildTooltip(note: ParsedNote, title: string, contextStr: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;

  md.appendMarkdown(`**${title}**\n\n`);

  const status = note.frontmatter.status ?? 'inbox';
  const statusLabel = GTD_LISTS[status as TaskStatus] ?? status;
  const rows: string[] = [
    `| 🏷 Status | ${statusLabel} |`,
  ];

  if (note.frontmatter.priority) {
    const pIcon = note.frontmatter.priority === 'high' ? '🔴' : note.frontmatter.priority === 'low' ? '🟢' : '🟡';
    rows.push(`| ${pIcon} Priority | ${note.frontmatter.priority} |`);
  }

  if (note.frontmatter.due) {
    const urgency = dueUrgency(note.frontmatter.due);
    const dueIcon = urgency === 'overdue' ? '🔥 Overdue' : urgency === 'soon' ? '⚠️ Due soon' : '📅 Due';
    rows.push(`| ${dueIcon} | ${note.frontmatter.due} |`);
  }

  rows.push(`| 🌐 Scope | ${note.source === 'workspace' ? 'Workspace' : 'Global'} |`);

  if (contextStr) rows.push(`| @ Context | ${contextStr} |`);
  if (note.frontmatter.project) rows.push(`| 📁 Project | ${note.frontmatter.project} |`);
  if (Array.isArray(note.frontmatter.tags) && note.frontmatter.tags.length > 0) {
    rows.push(`| 🔖 Tags | ${note.frontmatter.tags.join(', ')} |`);
  }
  if (note.frontmatter.created) rows.push(`| 📅 Created | ${note.frontmatter.created.slice(0, 10)} |`);

  md.appendMarkdown('| | |\n|:---|:---|\n' + rows.join('\n'));

  const bodyPreview = note.body.trim().slice(0, 300);
  if (bodyPreview) {
    md.appendMarkdown('\n\n---\n\n' + bodyPreview);
  }

  return md;
}
