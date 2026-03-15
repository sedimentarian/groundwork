import * as vscode from 'vscode';
import { VaultStore } from '../vault/store';
import { ParsedNote, TaskStatus, GTD_LISTS } from '../vault/types';

type TaskTreeItem = TaskGroup | TaskItem;

class TaskGroup {
  constructor(public status: TaskStatus, public tasks: ParsedNote[]) {}
}

class TaskItem {
  constructor(public note: ParsedNote) {}
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: Map<TaskStatus, ParsedNote[]> = new Map();

  constructor(private store: VaultStore) {}

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element instanceof TaskGroup) {
      const label = `${GTD_LISTS[element.status]} (${element.tasks.length})`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(statusIcon(element.status));
      item.contextValue = 'task-group';
      return item;
    }

    const note = element.note;
    const title = note.frontmatter.title ?? note.relativePath;
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);

    item.command = {
      command: 'vscode.open',
      title: 'Open Task',
      arguments: [vscode.Uri.file(note.path)],
    };

    const contexts = note.frontmatter.context;
    if (contexts && Array.isArray(contexts) && contexts.length > 0) {
      item.description = contexts.join(', ');
    }

    if (note.frontmatter.priority === 'high') {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground'));
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    item.contextValue = 'task-item';
    item.tooltip = note.body.trim().slice(0, 200);

    return item;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      // Root: show GTD status groups that have tasks
      const allTasks = await this.store.queryNotes({ type: 'task' });

      this.cache.clear();
      for (const task of allTasks) {
        const status = (task.frontmatter.status as TaskStatus) ?? 'inbox';
        if (!this.cache.has(status)) this.cache.set(status, []);
        this.cache.get(status)!.push(task);
      }

      // Show groups in GTD order, only if they have tasks
      const order: TaskStatus[] = ['inbox', 'next', 'active', 'waiting', 'someday', 'done'];
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

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'inbox': return 'inbox';
    case 'next': return 'arrow-right';
    case 'active': return 'play';
    case 'waiting': return 'clock';
    case 'someday': return 'cloud';
    case 'done': return 'check';
    case 'cancelled': return 'close';
    default: return 'question';
  }
}
