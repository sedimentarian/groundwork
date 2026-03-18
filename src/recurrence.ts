import { NoteFrontmatter } from './vault/types';

/**
 * Recurrence pattern parser and evaluator.
 *
 * Supported patterns (case-insensitive):
 *   "every day"            — daily
 *   "every weekday"        — Mon-Fri
 *   "every Monday"         — weekly on that day
 *   "every 2 weeks"        — every N weeks from anchor
 *   "every month"          — same day of month
 *   "1st of month"         — first day of each month
 *   "15th of month"        — 15th of each month
 *   "every 3 months"       — quarterly from anchor
 *
 * Frontmatter fields:
 *   recurrence: "every Monday"
 *   recurrence-anchor: "2026-03-17"   (ISO date string, defaults to task created date)
 */

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

export interface RecurrenceRule {
  type: 'daily' | 'weekday' | 'weekly-day' | 'every-n-weeks' | 'monthly' | 'nth-of-month' | 'every-n-months';
  dayOfWeek?: number;    // 0-6 for weekly-day
  interval?: number;     // for every-n-weeks, every-n-months
  dayOfMonth?: number;   // for nth-of-month
}

/** Parse a recurrence string into a structured rule. Returns undefined if unrecognized. */
export function parseRecurrence(pattern: string): RecurrenceRule | undefined {
  const p = pattern.trim().toLowerCase();

  if (p === 'every day' || p === 'daily') {
    return { type: 'daily' };
  }

  if (p === 'every weekday' || p === 'weekdays') {
    return { type: 'weekday' };
  }

  // "every Monday", "every tuesday", etc.
  for (const [name, dow] of Object.entries(DAY_NAMES)) {
    if (p === `every ${name}`) {
      return { type: 'weekly-day', dayOfWeek: dow };
    }
  }

  // "every 2 weeks", "every 3 weeks"
  const weeksMatch = p.match(/^every\s+(\d+)\s+weeks?$/);
  if (weeksMatch) {
    return { type: 'every-n-weeks', interval: parseInt(weeksMatch[1], 10) };
  }

  // "every month", "monthly"
  if (p === 'every month' || p === 'monthly') {
    return { type: 'monthly' };
  }

  // "1st of month", "15th of month", "2nd of month"
  const nthMatch = p.match(/^(\d+)(?:st|nd|rd|th)\s+of\s+(?:each\s+)?month$/);
  if (nthMatch) {
    return { type: 'nth-of-month', dayOfMonth: parseInt(nthMatch[1], 10) };
  }

  // "every 3 months", "every 6 months", "quarterly"
  if (p === 'quarterly') {
    return { type: 'every-n-months', interval: 3 };
  }
  const monthsMatch = p.match(/^every\s+(\d+)\s+months?$/);
  if (monthsMatch) {
    return { type: 'every-n-months', interval: parseInt(monthsMatch[1], 10) };
  }

  return undefined;
}

/** Check if a recurring task needs a new instance cloned today. */
export function isRecurrenceDue(fm: NoteFrontmatter, today?: Date): boolean {
  const recurrenceStr = fm.recurrence as string | undefined;
  if (!recurrenceStr) return false;

  // Only clone from completed tasks
  if (fm.status !== 'done') return false;

  const rule = parseRecurrence(recurrenceStr);
  if (!rule) return false;

  const now = today ?? new Date();
  const anchor = fm['recurrence-anchor']
    ? new Date(fm['recurrence-anchor'] as string)
    : fm.modified ? new Date(fm.modified) : new Date(fm.created as string);

  if (isNaN(anchor.getTime())) return false;

  // Don't clone again on the same day as completion
  const anchorDay = toDateStr(anchor);
  const todayStr = toDateStr(now);
  if (anchorDay === todayStr) return false;

  return matchesRule(rule, anchor, now);
}

function matchesRule(rule: RecurrenceRule, anchor: Date, now: Date): boolean {
  const dow = now.getDay();
  const dom = now.getDate();

  switch (rule.type) {
    case 'daily':
      return true;

    case 'weekday':
      return dow >= 1 && dow <= 5;

    case 'weekly-day':
      return dow === rule.dayOfWeek;

    case 'every-n-weeks': {
      if (dow !== anchor.getDay()) return false;
      const diffWeeks = Math.floor((now.getTime() - anchor.getTime()) / (7 * 86_400_000));
      return diffWeeks > 0 && diffWeeks % (rule.interval ?? 1) === 0;
    }

    case 'monthly':
      return dom === anchor.getDate() && !sameMonth(anchor, now);

    case 'nth-of-month':
      return dom === rule.dayOfMonth;

    case 'every-n-months': {
      if (dom !== anchor.getDate()) return false;
      const monthDiff = (now.getFullYear() - anchor.getFullYear()) * 12 + (now.getMonth() - anchor.getMonth());
      return monthDiff > 0 && monthDiff % (rule.interval ?? 1) === 0;
    }

    default:
      return false;
  }
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build frontmatter for a cloned recurring task instance. */
export function buildCloneFrontmatter(original: NoteFrontmatter): NoteFrontmatter {
  const clone: NoteFrontmatter = { ...original };
  clone.status = 'inbox';
  clone.created = new Date().toISOString();
  clone.modified = new Date().toISOString();
  // Update anchor to today so we don't re-clone tomorrow
  clone['recurrence-anchor'] = new Date().toISOString().slice(0, 10);
  // Remove completion-related fields
  delete clone['completed'];
  return clone;
}
