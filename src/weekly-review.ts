import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from './vault/manager';
import { ParsedNote, TaskStatus, GTD_LISTS } from './vault/types';
import { SessionTracker } from './session/tracker';

export class WeeklyReviewPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private manager: VaultManager,
    private extensionUri: vscode.Uri,
    private onAction?: () => void
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'groundwork.weeklyReview',
      '📋 Weekly Review',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'openFile') {
        vscode.commands.executeCommand('groundwork.openEditor', vscode.Uri.file(msg.path));
      }
      if (msg.type === 'setStatus') {
        const note = await this.manager.readNote(msg.path);
        const oldStatus = note.frontmatter.status ?? 'inbox';
        note.frontmatter.status = msg.status;
        await this.manager.writeNote(msg.path, note.frontmatter, note.body);
        this.onAction?.();
        await this.refresh();
      }
      if (msg.type === 'refresh') {
        await this.refresh();
      }
    });

    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;

    const allTasks = await this.manager.queryNotes({ type: 'task' });
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    // Categorize tasks
    const overdue: ParsedNote[] = [];
    const dueThisWeek: ParsedNote[] = [];
    const active: ParsedNote[] = [];
    const next: ParsedNote[] = [];
    const waiting: ParsedNote[] = [];
    const someday: ParsedNote[] = [];
    const inbox: ParsedNote[] = [];
    const completedThisWeek: ParsedNote[] = [];
    const cancelledThisWeek: ParsedNote[] = [];
    let createdThisWeek = 0;

    for (const t of allTasks) {
      const status = t.frontmatter.status ?? 'inbox';

      // Count tasks created this week
      if (t.frontmatter.created) {
        const created = new Date(t.frontmatter.created);
        if (!isNaN(created.getTime()) && created >= weekAgo) createdThisWeek++;
      }

      // Completed/cancelled this week
      if (status === 'done' || status === 'cancelled') {
        if (t.frontmatter.modified) {
          const mod = new Date(t.frontmatter.modified);
          if (!isNaN(mod.getTime()) && mod >= weekAgo) {
            if (status === 'done') completedThisWeek.push(t);
            else cancelledThisWeek.push(t);
          }
        }
        continue;
      }

      // Due date urgency
      if (t.frontmatter.due) {
        const due = new Date(t.frontmatter.due);
        if (!isNaN(due.getTime())) {
          const diffDays = (due.getTime() - now.getTime()) / 86_400_000;
          if (diffDays < 0) overdue.push(t);
          else if (diffDays <= 7) dueThisWeek.push(t);
        }
      }

      switch (status) {
        case 'active': active.push(t); break;
        case 'next': next.push(t); break;
        case 'waiting': waiting.push(t); break;
        case 'someday': someday.push(t); break;
        case 'inbox': inbox.push(t); break;
      }
    }

    const totalOpen = active.length + next.length + waiting.length + inbox.length + someday.length;

    const data: ReviewData = {
      overdue, dueThisWeek, active, next, waiting, someday, inbox,
      completedThisWeek, cancelledThisWeek, createdThisWeek, totalOpen, now,
    };

    this.panel.webview.html = buildHtml(data);
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface ReviewData {
  overdue: ParsedNote[];
  dueThisWeek: ParsedNote[];
  active: ParsedNote[];
  next: ParsedNote[];
  waiting: ParsedNote[];
  someday: ParsedNote[];
  inbox: ParsedNote[];
  completedThisWeek: ParsedNote[];
  cancelledThisWeek: ParsedNote[];
  createdThisWeek: number;
  totalOpen: number;
  now: Date;
}

// ── HTML Builder ───────────────────────────────────────────────────────────

function buildHtml(data: ReviewData): string {
  const nonce = getNonce();
  const weekStart = new Date(data.now.getTime() - 7 * 86_400_000);
  const dateRange = `${fmtDate(weekStart)} — ${fmtDate(data.now)}`;

  const sections: string[] = [];

  // Overdue
  if (data.overdue.length > 0) {
    sections.push(renderActionSection('🔥 Overdue', data.overdue, 'overdue',
      ['done', 'active', 'next']));
  }

  // Due this week
  if (data.dueThisWeek.length > 0) {
    sections.push(renderActionSection('⚠️ Due This Week', data.dueThisWeek, 'due-soon',
      ['done', 'active']));
  }

  // Active — still working on these?
  if (data.active.length > 0) {
    sections.push(renderActionSection('▶️ Active — Still In Progress?', data.active, 'active',
      ['done', 'waiting', 'next', 'someday']));
  }

  // Waiting — anything unblocked?
  if (data.waiting.length > 0) {
    sections.push(renderActionSection('⏳ Waiting For — Anything Unblocked?', data.waiting, 'waiting',
      ['next', 'active', 'done']));
  }

  // Inbox — needs triage
  if (data.inbox.length > 0) {
    sections.push(renderActionSection('📥 Inbox — Needs Triage', data.inbox, 'inbox',
      ['next', 'active', 'waiting', 'someday', 'done', 'cancelled']));
  }

  // Next actions
  if (data.next.length > 0) {
    sections.push(renderActionSection('➡️ Next Actions — Still Relevant?', data.next, 'next',
      ['active', 'done', 'waiting', 'someday']));
  }

  // Someday — promote or kill?
  if (data.someday.length > 0) {
    sections.push(renderActionSection('💭 Someday / Maybe — Promote or Kill?', data.someday, 'someday',
      ['next', 'active', 'cancelled']));
  }

  // Completed this week
  if (data.completedThisWeek.length > 0) {
    sections.push(`
      <div class="section done">
        <h2>✅ Completed This Week (${data.completedThisWeek.length})</h2>
        <div class="task-list">
          ${data.completedThisWeek.map(t => `
            <div class="task-row done-row">
              <span class="task-title clickable" data-path="${esc(t.path)}">${esc(t.frontmatter.title ?? t.relativePath)}</span>
              <span class="meta">${t.frontmatter.modified ? timeAgo(new Date(t.frontmatter.modified), data.now) : ''}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `);
  }

  // Empty state
  if (sections.length === 0) {
    sections.push(`
      <div class="empty-state">
        <p>🎉 All clear! No tasks to review this week.</p>
      </div>
    `);
  }

  // Stats bar
  const stats = `
    <div class="stats-bar">
      <span class="stat">${data.completedThisWeek.length} completed</span>
      <span class="stat">${data.createdThisWeek} created</span>
      <span class="stat">${data.overdue.length} overdue</span>
      <span class="stat">${data.active.length} active</span>
      <span class="stat">${data.totalOpen} total open</span>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --input-bg: var(--vscode-input-background, #2d2d2d);
      --border: var(--vscode-panel-border, #444);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #fff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --error: var(--vscode-errorForeground, #f44747);
      --warning: var(--vscode-editorWarning-foreground, #cca700);
      --success: var(--vscode-testing-iconPassed, #73c991);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: 13px;
      padding: 0;
    }

    .header {
      padding: 20px 28px 12px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .header .date { opacity: 0.5; font-size: 13px; }
    .header .refresh-btn {
      float: right;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-top: -24px;
    }
    .header .refresh-btn:hover { background: var(--input-bg); }

    .stats-bar {
      display: flex;
      gap: 16px;
      padding: 10px 28px;
      border-bottom: 1px solid var(--border);
      background: var(--input-bg);
      font-size: 12px;
    }
    .stat { opacity: 0.7; }

    .section {
      padding: 16px 28px 8px;
    }
    .section h2 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }
    .section.overdue h2 { color: var(--error); }
    .section.due-soon h2 { color: var(--warning); }

    .task-list { display: flex; flex-direction: column; gap: 1px; }
    .task-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
      padding: 8px 10px;
      border-radius: 4px;
      transition: background 0.1s;
    }
    .task-row:hover { background: var(--input-bg); }

    .task-title {
      flex: 1;
      min-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-title.clickable { cursor: pointer; }
    .task-title.clickable:hover { color: var(--accent); text-decoration: underline; }

    .task-meta {
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 11px;
      opacity: 0.55;
      flex-shrink: 0;
    }
    .priority-high { color: var(--error); font-weight: bold; }
    .priority-low { opacity: 0.4; }
    .due-label { font-size: 11px; }
    .due-overdue { color: var(--error); }
    .due-soon { color: var(--warning); }

    .actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .action-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.15s, background 0.1s;
    }
    .task-row:hover .action-btn { opacity: 0.7; }
    .action-btn:hover { background: var(--btn-bg); color: var(--btn-fg); opacity: 1 !important; }

    .scope-badge {
      font-size: 10px;
      opacity: 0.5;
    }

    .meta { font-size: 11px; opacity: 0.4; }

    .done-row { opacity: 0.5; }
    .done-row .task-title { text-decoration: line-through; }

    .empty-state {
      text-align: center;
      padding: 60px 28px;
      opacity: 0.5;
      font-size: 16px;
    }

    .content { padding-bottom: 40px; }
  </style>
</head>
<body>
  <div class="header">
    <button class="refresh-btn" id="refresh-btn">↻ Refresh</button>
    <h1>📋 Weekly Review</h1>
    <div class="date">${esc(dateRange)}</div>
  </div>
  ${stats}
  <div class="content">
    ${sections.join('\n')}
  </div>

  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', function(e) {
      const title = e.target.closest('.task-title.clickable');
      if (title) {
        vscode.postMessage({ type: 'openFile', path: title.dataset.path });
        return;
      }

      const btn = e.target.closest('.action-btn');
      if (btn) {
        vscode.postMessage({ type: 'setStatus', path: btn.dataset.path, status: btn.dataset.status });
        return;
      }

      if (e.target.id === 'refresh-btn' || e.target.closest('#refresh-btn')) {
        vscode.postMessage({ type: 'refresh' });
        return;
      }
    });
  })();
  </script>
</body>
</html>`;
}

function renderActionSection(heading: string, tasks: ParsedNote[], cssClass: string, statusOptions: TaskStatus[]): string {
  const statusLabels: Record<string, string> = {
    done: '✓ Done',
    active: '▶ Active',
    next: '→ Next',
    waiting: '⏳ Wait',
    someday: '💭 Someday',
    inbox: '📥 Inbox',
    cancelled: '✕ Cancel',
  };

  return `
    <div class="section ${cssClass}">
      <h2>${heading} (${tasks.length})</h2>
      <div class="task-list">
        ${tasks.map(t => {
          const fm = t.frontmatter;
          const title = fm.title ?? t.relativePath;
          const scope = t.source === 'workspace' ? '📂' : '🌐';
          const priority = fm.priority ?? 'medium';

          let dueHtml = '';
          if (fm.due) {
            const due = new Date(fm.due);
            if (!isNaN(due.getTime())) {
              const diffDays = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
              const cls = diffDays < 0 ? 'due-overdue' : diffDays <= 3 ? 'due-soon' : '';
              const label = diffDays < 0
                ? `${Math.abs(diffDays)}d overdue`
                : diffDays === 0 ? 'today'
                : diffDays === 1 ? 'tomorrow'
                : `in ${diffDays}d`;
              dueHtml = `<span class="due-label ${cls}">${esc(label)}</span>`;
            }
          }

          const prioHtml = priority === 'high'
            ? '<span class="priority-high">!!!</span>'
            : priority === 'low'
            ? '<span class="priority-low">—</span>'
            : '';

          const actionBtns = statusOptions.map(s =>
            `<button class="action-btn" data-path="${esc(t.path)}" data-status="${s}">${statusLabels[s] ?? s}</button>`
          ).join('');

          return `
            <div class="task-row">
              <span class="task-title clickable" data-path="${esc(t.path)}">${esc(title)}</span>
              <div class="task-meta">
                ${prioHtml}
                ${dueHtml}
                <span class="scope-badge">${scope}</span>
              </div>
              <div class="actions">${actionBtns}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function timeAgo(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours === 1) return '1h ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}
