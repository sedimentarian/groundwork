import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { ParsedNote } from '../vault/types';
import { isRecurrenceDue, buildCloneFrontmatter } from '../recurrence';
import { GroundworkDB } from '../db/index';
import { taskStats as dbTaskStats, listTasks } from '../db/queries';

export class BriefingPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private onAction: (() => void) | undefined;

  constructor(
    private manager: VaultManager,
    private extensionUri: vscode.Uri,
    onAction?: () => void,
    private db?: GroundworkDB
  ) {
    this.onAction = onAction;
  }

  /** Generate an AI summary using VS Code Language Model API, falling back to template */
  private async generateSummary(data: BriefingData): Promise<string> {
    // Try AI summary first
    try {
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      const model = models[0];
      if (!model) throw new Error('No model available');

      const prompt = `You are a concise daily briefing assistant. Given this task summary, write 2-3 short sentences about what the user should focus on today. Be direct, helpful, and motivating. No bullet points, no headers.

Tasks:
- ${data.overdue.length} overdue${data.overdue.length > 0 ? ` (${data.overdue.map(t => t.frontmatter.title).join(', ')})` : ''}
- ${data.active.length} active${data.active.length > 0 ? ` (${data.active.map(t => t.frontmatter.title).join(', ')})` : ''}
- ${data.next.length} next actions
- ${data.inbox.length} in inbox needing triage
- ${data.waiting.length} waiting
- ${data.dueSoon.length} due within 3 days${data.dueSoon.length > 0 ? ` (${data.dueSoon.map(t => t.frontmatter.title).join(', ')})` : ''}
- ${data.recentlyDone.length} completed recently
- ${data.cloned.length} recurring tasks cloned today`;

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }
      return result.trim();
    } catch {
      // Fall back to template summary
      return this.buildTemplateSummary(data);
    }
  }

  /** Smart template-based summary when AI is unavailable */
  private buildTemplateSummary(data: BriefingData): string {
    const parts: string[] = [];

    if (data.overdue.length > 0) {
      const names = data.overdue.slice(0, 2).map(t => t.frontmatter.title ?? 'Untitled');
      parts.push(`${data.overdue.length} task${data.overdue.length > 1 ? 's are' : ' is'} overdue — ${names.join(' and ')}${data.overdue.length > 2 ? ` and ${data.overdue.length - 2} more` : ''} need${data.overdue.length === 1 ? 's' : ''} attention.`);
    }

    if (data.dueSoon.length > 0 && data.overdue.length === 0) {
      parts.push(`${data.dueSoon.length} task${data.dueSoon.length > 1 ? 's' : ''} due in the next 3 days.`);
    }

    if (data.active.length > 0) {
      parts.push(`${data.active.length} active — focus on ${data.active[0].frontmatter.title ?? 'your current work'}.`);
    } else if (data.next.length > 0) {
      parts.push(`Nothing active. Pick up "${data.next[0].frontmatter.title ?? 'a next action'}" to get going.`);
    }

    if (data.inbox.length > 0) {
      parts.push(`${data.inbox.length} item${data.inbox.length > 1 ? 's' : ''} in inbox to triage.`);
    }

    if (data.recentlyDone.length > 0 && parts.length < 3) {
      parts.push(`${data.recentlyDone.length} completed recently — nice work.`);
    }

    if (parts.length === 0) {
      parts.push('All clear — nothing needs attention right now.');
    }

    return parts.join(' ');
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'groundwork.briefing',
      '☀️ Daily Briefing',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'openFile') {
        vscode.commands.executeCommand('groundwork.openEditor', vscode.Uri.file(msg.path));
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

    // Process recurrence — clone any due recurring tasks
    const cloned: string[] = [];
    for (const task of allTasks) {
      if (isRecurrenceDue(task.frontmatter, now)) {
        const cloneFm = buildCloneFrontmatter(task.frontmatter);
        const slug = (cloneFm.title ?? 'recurring-task')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const store = this.manager.storeFor(task.source) ?? this.manager.globalStore;
        const rootDir = this.manager.rootDirFor(task.source) ?? this.manager.globalPath;
        const filePath = await store.findAvailablePath(path.join(rootDir, 'inbox'), slug);
        await this.manager.writeNote(filePath, cloneFm, task.body);

        // Update original's anchor so it doesn't clone again
        task.frontmatter['recurrence-anchor'] = now.toISOString().slice(0, 10);
        await this.manager.writeNote(task.path, task.frontmatter, task.body);

        cloned.push(cloneFm.title ?? slug);
      }
    }

    // Re-query after cloning
    const tasks = cloned.length > 0
      ? await this.manager.queryNotes({ type: 'task' })
      : allTasks;

    // Categorize
    const overdue: ParsedNote[] = [];
    const dueSoon: ParsedNote[] = [];
    const active: ParsedNote[] = [];
    const next: ParsedNote[] = [];
    const inbox: ParsedNote[] = [];
    const waiting: ParsedNote[] = [];
    const recentlyDone: ParsedNote[] = [];
    const recurring: ParsedNote[] = [];

    const oneDayAgo = new Date(now.getTime() - 86_400_000);

    for (const t of tasks) {
      const status = t.frontmatter.status ?? 'inbox';

      // Track recurring tasks (any status)
      if (t.frontmatter.recurrence) {
        recurring.push(t);
      }

      if (status === 'done' || status === 'cancelled') {
        if (t.frontmatter.modified) {
          const mod = new Date(t.frontmatter.modified);
          if (mod >= oneDayAgo) recentlyDone.push(t);
        }
        continue;
      }

      // Check due date urgency
      if (t.frontmatter.due) {
        const due = new Date(t.frontmatter.due);
        if (!isNaN(due.getTime())) {
          const diffDays = (due.getTime() - now.getTime()) / 86_400_000;
          if (diffDays < 0) overdue.push(t);
          else if (diffDays <= 3) dueSoon.push(t);
        }
      }

      switch (status) {
        case 'active': active.push(t); break;
        case 'next': next.push(t); break;
        case 'inbox': inbox.push(t); break;
        case 'waiting': waiting.push(t); break;
      }
    }

    const briefingData: BriefingData = {
      overdue, dueSoon, active, next, inbox, waiting,
      recentlyDone, recurring, cloned, now, summary: '',
    };

    // Render immediately with template summary, then upgrade with AI
    briefingData.summary = this.buildTemplateSummary(briefingData);
    this.panel.webview.html = buildHtml(briefingData);

    // Try AI summary in background — update if successful
    this.generateSummary(briefingData).then(aiSummary => {
      if (this.panel && aiSummary !== briefingData.summary) {
        briefingData.summary = aiSummary;
        this.panel.webview.html = buildHtml(briefingData);
      }
    }).catch(() => {
      // AI summary is optional — template summary is already displayed
    });
  }

  /** Summary string for status bar */
  async getStatusSummary(): Promise<{ active: number; overdue: number; inbox: number }> {
    // Use DB stats when available — avoids reading all files
    if (this.db?.isOpen) {
      const stats = dbTaskStats(this.db);
      const todayStr = new Date().toISOString().slice(0, 10);
      const overdueTasks = listTasks(this.db, {}).filter(r =>
        r.due && r.due < todayStr && r.status !== 'done' && r.status !== 'cancelled'
      );
      return { active: stats.active ?? 0, overdue: overdueTasks.length, inbox: stats.inbox ?? 0 };
    }

    // Fallback: filesystem path
    const tasks = await this.manager.queryNotes({ type: 'task' });
    const now = new Date();
    let activeCount = 0;
    let overdueCount = 0;
    let inboxCount = 0;

    for (const t of tasks) {
      const status = t.frontmatter.status ?? 'inbox';
      if (status === 'done' || status === 'cancelled') continue;
      if (status === 'active') activeCount++;
      if (status === 'inbox') inboxCount++;
      if (t.frontmatter.due) {
        const due = new Date(t.frontmatter.due);
        if (!isNaN(due.getTime()) && due.getTime() < now.getTime()) overdueCount++;
      }
    }

    return { active: activeCount, overdue: overdueCount, inbox: inboxCount };
  }
}

// ── HTML Builder ───────────────────────────────────────────────────────────────

interface BriefingData {
  overdue: ParsedNote[];
  dueSoon: ParsedNote[];
  active: ParsedNote[];
  next: ParsedNote[];
  inbox: ParsedNote[];
  waiting: ParsedNote[];
  recentlyDone: ParsedNote[];
  recurring: ParsedNote[];
  cloned: string[];
  now: Date;
  summary: string;
}

function buildHtml(data: BriefingData): string {
  const nonce = getNonce();
  const dateStr = data.now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const sections: string[] = [];

  // Cloned recurring tasks notification
  if (data.cloned.length > 0) {
    sections.push(`
      <div class="notification">
        🔄 Recurring tasks cloned to inbox: <strong>${esc(data.cloned.join(', '))}</strong>
      </div>
    `);
  }

  // Overdue
  if (data.overdue.length > 0) {
    sections.push(renderSection('🔥 Overdue', data.overdue, 'overdue'));
  }

  // Due soon
  if (data.dueSoon.length > 0) {
    sections.push(renderSection('⚠️ Due Soon', data.dueSoon, 'due-soon'));
  }

  // Active
  if (data.active.length > 0) {
    sections.push(renderSection('▶️ Active', data.active, 'active'));
  }

  // Next actions
  if (data.next.length > 0) {
    sections.push(renderSection('➡️ Next Actions', data.next, 'next'));
  }

  // Inbox
  if (data.inbox.length > 0) {
    sections.push(renderSection('📥 Inbox — Needs Triage', data.inbox, 'inbox'));
  }

  // Waiting
  if (data.waiting.length > 0) {
    sections.push(renderSection('⏳ Waiting For', data.waiting, 'waiting'));
  }

  // Recently completed
  if (data.recentlyDone.length > 0) {
    sections.push(`
      <div class="section done">
        <h2>✅ Recently Completed</h2>
        <div class="task-list">
          ${data.recentlyDone.map(t => `
            <div class="task-row done-row">
              <span class="task-title clickable" data-path="${esc(t.path)}" role="link" tabindex="0">${esc(t.frontmatter.title ?? t.relativePath)}</span>
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
        <p>🎉 All clear! No tasks need attention right now.</p>
      </div>
    `);
  }

  // Stats bar
  const totalOpen = data.active.length + data.next.length + data.inbox.length + data.waiting.length;
  const stats = `
    <div class="stats-bar" role="status" aria-label="Task statistics">
      <span class="stat">${data.overdue.length} overdue</span>
      <span class="stat">${data.active.length} active</span>
      <span class="stat">${totalOpen} open</span>
      <span class="stat">${data.recentlyDone.length} done today</span>
      <span class="stat">${data.recurring.length} recurring</span>
    </div>
  `;

  // Summary block
  const summaryHtml = `
    <div class="summary" aria-live="polite">
      <p>${esc(data.summary)}</p>
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

    .notification {
      margin: 12px 28px;
      padding: 10px 14px;
      background: var(--input-bg);
      border-left: 3px solid var(--accent);
      border-radius: 4px;
      font-size: 12px;
    }

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

    .summary {
      padding: 14px 28px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      line-height: 1.5;
      opacity: 0.85;
      font-style: italic;
    }

    .done-row { opacity: 0.5; }
    .done-row .task-title { text-decoration: line-through; }

    .scope-badge {
      font-size: 10px;
      opacity: 0.5;
    }

    .meta { font-size: 11px; opacity: 0.4; }

    .recurrence-badge {
      font-size: 10px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 5px;
      opacity: 0.6;
    }

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
  <div class="header" role="banner">
    <button class="refresh-btn" id="refresh-btn" aria-label="Refresh briefing">↻ Refresh</button>
    <h1>☀️ Daily Briefing</h1>
    <div class="date">${esc(dateStr)}</div>
  </div>
  ${stats}
  ${summaryHtml}
  <main class="content">
    ${sections.join('\n')}
  </main>

  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();

    function handleActivation(e) {
      var title = e.target.closest('.task-title.clickable');
      if (title) {
        vscode.postMessage({ type: 'openFile', path: title.dataset.path });
        return;
      }

      if (e.target.id === 'refresh-btn' || e.target.closest('#refresh-btn')) {
        vscode.postMessage({ type: 'refresh' });
        return;
      }
    }

    document.addEventListener('click', handleActivation);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        var el = e.target.closest('.task-title.clickable, #refresh-btn');
        if (el) { e.preventDefault(); handleActivation(e); }
      }
    });
  })();
  </script>
</body>
</html>`;
}

function renderSection(heading: string, tasks: ParsedNote[], cssClass: string): string {
  return `
    <div class="section ${cssClass}">
      <h2>${heading} (${tasks.length})</h2>
      <div class="task-list">
        ${tasks.map(t => renderTaskRow(t)).join('')}
      </div>
    </div>
  `;
}

function renderTaskRow(task: ParsedNote): string {
  const fm = task.frontmatter;
  const title = fm.title ?? task.relativePath;
  const status = fm.status ?? 'inbox';
  const scope = task.source === 'workspace' ? '📂' : '🌐';
  const priority = fm.priority ?? 'medium';

  // Due date display
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

  // Recurrence badge
  const recurrenceHtml = fm.recurrence
    ? `<span class="recurrence-badge">🔄 ${esc(fm.recurrence as string)}</span>`
    : '';

  // Priority indicator
  const prioHtml = priority === 'high'
    ? '<span class="priority-high">!!!</span>'
    : priority === 'low'
    ? '<span class="priority-low">—</span>'
    : '';

  return `
    <div class="task-row">
      <span class="task-title clickable" data-path="${esc(task.path)}" role="link" tabindex="0">${esc(title)}</span>
      <div class="task-meta">
        ${prioHtml}
        ${dueHtml}
        ${recurrenceHtml}
        <span class="scope-badge">${scope}</span>
      </div>
    </div>
  `;
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
