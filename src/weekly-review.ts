import * as vscode from 'vscode';
import { VaultManager } from './vault/manager';
import { ParsedNote, TaskStatus, GTD_LISTS } from './vault/types';
import { SessionTracker } from './session/tracker';
import * as path from 'path';

/**
 * Guided GTD weekly review — walks through each phase of the review:
 *
 * 1. Waiting For  — anything unblocked? Move to Next/Active
 * 2. Active       — still working on these? Complete or pause?
 * 3. Someday      — promote, kill, or keep?
 * 4. Inbox        — triage each untriaged item
 * 5. Recently Done — celebrate, note follow-ups
 * 6. Capture      — anything new to add?
 */
export async function runWeeklyReview(
  manager: VaultManager,
  sessionTracker: SessionTracker,
  refreshAll: () => void,
): Promise<void> {
  const allTasks = await manager.queryNotes({ type: 'task' });

  const byStatus = (status: TaskStatus) =>
    allTasks.filter(t => t.frontmatter.status === status);

  const waiting = byStatus('waiting');
  const active = byStatus('active');
  const someday = byStatus('someday');
  const inbox = byStatus('inbox');
  const done = recentlyCompleted(allTasks, 7);

  const stats = {
    reviewed: 0,
    moved: 0,
    completed: 0,
    captured: 0,
  };

  // ── Phase 1: Waiting For ──────────────────────────────────────────────
  if (waiting.length > 0) {
    const cont = await reviewPhase(
      '1/6 — Waiting For',
      `${waiting.length} task(s) blocked on something. Any of them unblocked?`,
      waiting,
      ['Unblocked → Next', 'Unblocked → Active', 'Still Waiting', 'Mark Done', 'Cancel → Remove'],
      async (task, action) => {
        const statusMap: Record<string, TaskStatus | null> = {
          'Unblocked → Next': 'next',
          'Unblocked → Active': 'active',
          'Still Waiting': null, // no change
          'Mark Done': 'done',
          'Cancel → Remove': 'cancelled',
        };
        const newStatus = statusMap[action];
        if (newStatus) {
          await changeStatus(manager, sessionTracker, task, newStatus);
          stats.moved++;
        }
        stats.reviewed++;
      }
    );
    if (!cont) return showSummary(stats, 'cancelled');
  }

  // ── Phase 2: Active ───────────────────────────────────────────────────
  if (active.length > 0) {
    const cont = await reviewPhase(
      '2/6 — Active',
      `${active.length} task(s) in progress. Still working on all of them?`,
      active,
      ['Still Active', 'Mark Done', 'Move to Waiting', 'Move to Next', 'Move to Someday'],
      async (task, action) => {
        const statusMap: Record<string, TaskStatus | null> = {
          'Still Active': null,
          'Mark Done': 'done',
          'Move to Waiting': 'waiting',
          'Move to Next': 'next',
          'Move to Someday': 'someday',
        };
        const newStatus = statusMap[action];
        if (newStatus) {
          await changeStatus(manager, sessionTracker, task, newStatus);
          if (newStatus === 'done') stats.completed++;
          else stats.moved++;
        }
        stats.reviewed++;
      }
    );
    if (!cont) return showSummary(stats, 'cancelled');
  }

  // ── Phase 3: Someday / Maybe ──────────────────────────────────────────
  if (someday.length > 0) {
    const cont = await reviewPhase(
      '3/6 — Someday / Maybe',
      `${someday.length} task(s) parked. Promote, kill, or keep?`,
      someday,
      ['Keep for Later', 'Promote → Next', 'Promote → Active', 'Cancel → Remove'],
      async (task, action) => {
        const statusMap: Record<string, TaskStatus | null> = {
          'Keep for Later': null,
          'Promote → Next': 'next',
          'Promote → Active': 'active',
          'Cancel → Remove': 'cancelled',
        };
        const newStatus = statusMap[action];
        if (newStatus) {
          await changeStatus(manager, sessionTracker, task, newStatus);
          stats.moved++;
        }
        stats.reviewed++;
      }
    );
    if (!cont) return showSummary(stats, 'cancelled');
  }

  // ── Phase 4: Inbox ────────────────────────────────────────────────────
  if (inbox.length > 0) {
    const cont = await reviewPhase(
      '4/6 — Inbox Triage',
      `${inbox.length} untriaged item(s). Where should each go?`,
      inbox,
      ['→ Next Actions', '→ Active', '→ Waiting', '→ Someday', 'Mark Done', 'Cancel → Remove', 'Leave in Inbox'],
      async (task, action) => {
        const statusMap: Record<string, TaskStatus | null> = {
          '→ Next Actions': 'next',
          '→ Active': 'active',
          '→ Waiting': 'waiting',
          '→ Someday': 'someday',
          'Mark Done': 'done',
          'Cancel → Remove': 'cancelled',
          'Leave in Inbox': null,
        };
        const newStatus = statusMap[action];
        if (newStatus) {
          await changeStatus(manager, sessionTracker, task, newStatus);
          stats.moved++;
        }
        stats.reviewed++;
      }
    );
    if (!cont) return showSummary(stats, 'cancelled');
  }

  // ── Phase 5: Recently Completed ───────────────────────────────────────
  if (done.length > 0) {
    const items = done.map(t => ({
      label: `$(check) ${t.frontmatter.title ?? path.basename(t.path)}`,
      description: t.frontmatter.project ?? '',
      detail: completedAgo(t),
    }));

    await vscode.window.showQuickPick(items, {
      placeHolder: `5/6 — ${done.length} task(s) completed this week. Nice work! Press Esc to continue.`,
      canPickMany: false,
    });
  }

  // ── Phase 6: Capture ──────────────────────────────────────────────────
  let capturing = true;
  while (capturing) {
    const newTask = await vscode.window.showInputBox({
      prompt: '6/6 — Anything new to capture? (leave blank to finish)',
      placeHolder: 'New task title, or press Enter to skip',
    });

    if (!newTask) {
      capturing = false;
    } else {
      const slug = newTask.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const store = manager.globalStore;
      const filePath = await store.findAvailablePath(
        path.join(manager.globalPath, 'inbox'),
        slug
      );

      await manager.writeNote(filePath, {
        title: newTask,
        type: 'task',
        status: 'inbox',
        created: new Date().toISOString(),
        priority: 'medium',
      }, `\n${newTask}\n\n## Notes\n\n`);

      await sessionTracker.log({ action: 'create', file: filePath });
      stats.captured++;
    }
  }

  refreshAll();
  await sessionTracker.log({
    action: 'activity_log',
    detail: `Weekly review completed: ${stats.reviewed} reviewed, ${stats.moved} moved, ${stats.completed} completed, ${stats.captured} captured`,
  });

  showSummary(stats, 'completed');
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Walk through a list of tasks one by one with action options. Returns false if user cancelled the review. */
async function reviewPhase(
  phase: string,
  intro: string,
  tasks: ParsedNote[],
  actions: string[],
  onAction: (task: ParsedNote, action: string) => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const title = task.frontmatter.title ?? path.basename(task.path);
    const project = task.frontmatter.project ? ` [${task.frontmatter.project}]` : '';
    const priority = task.frontmatter.priority ? ` (${task.frontmatter.priority})` : '';
    const due = task.frontmatter.due ? ` — due ${task.frontmatter.due}` : '';
    const body = task.body.trim().split('\n')[0].slice(0, 80);

    const items = actions.map(a => ({
      label: a,
      description: '',
    }));

    // Add skip-rest option
    items.push({ label: '$(debug-step-over) Skip remaining in this phase', description: '' });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${phase} — (${i + 1}/${tasks.length}) ${title}${project}${priority}${due}`,
      title: body || undefined,
    });

    if (!picked) return false; // Esc = cancel entire review

    if (picked.label.includes('Skip remaining')) break;

    await onAction(task, picked.label);
  }

  return true;
}

async function changeStatus(
  manager: VaultManager,
  tracker: SessionTracker,
  task: ParsedNote,
  newStatus: TaskStatus,
): Promise<void> {
  const oldStatus = task.frontmatter.status ?? 'inbox';
  task.frontmatter.status = newStatus;
  await manager.writeNote(task.path, task.frontmatter, task.body);
  await tracker.log({
    action: 'status_change',
    file: task.path,
    detail: `${oldStatus} → ${newStatus} (weekly review)`,
  });
}

function recentlyCompleted(tasks: ParsedNote[], days: number): ParsedNote[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  return tasks.filter(t => {
    if (t.frontmatter.status !== 'done') return false;
    const modified = t.frontmatter.modified;
    return modified ? modified >= cutoffStr : false;
  });
}

function completedAgo(task: ParsedNote): string {
  const modified = task.frontmatter.modified;
  if (!modified) return '';

  const diff = Date.now() - new Date(modified).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function showSummary(stats: { reviewed: number; moved: number; completed: number; captured: number }, status: string): void {
  const parts: string[] = [];
  if (stats.reviewed > 0) parts.push(`${stats.reviewed} reviewed`);
  if (stats.moved > 0) parts.push(`${stats.moved} moved`);
  if (stats.completed > 0) parts.push(`${stats.completed} completed`);
  if (stats.captured > 0) parts.push(`${stats.captured} captured`);

  const summary = parts.length > 0 ? parts.join(', ') : 'nothing changed';
  const icon = status === 'completed' ? '✓' : '⏸';
  vscode.window.showInformationMessage(`Weekly review ${status} ${icon} — ${summary}`);
}
