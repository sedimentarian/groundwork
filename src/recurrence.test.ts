import { describe, it, expect } from 'vitest';
import { parseRecurrence, isRecurrenceDue, buildCloneFrontmatter } from './recurrence';
import { NoteFrontmatter } from './vault/types';

// ---------- parseRecurrence ----------

describe('parseRecurrence', () => {
  it('parses "daily"', () => {
    expect(parseRecurrence('daily')).toEqual({ type: 'daily' });
  });

  it('parses "every day"', () => {
    expect(parseRecurrence('every day')).toEqual({ type: 'daily' });
  });

  it('parses "every weekday"', () => {
    expect(parseRecurrence('every weekday')).toEqual({ type: 'weekday' });
  });

  it('parses "weekdays"', () => {
    expect(parseRecurrence('weekdays')).toEqual({ type: 'weekday' });
  });

  it('parses "every Monday" (case-insensitive)', () => {
    expect(parseRecurrence('every Monday')).toEqual({ type: 'weekly-day', dayOfWeek: 1 });
  });

  it('parses "every friday"', () => {
    expect(parseRecurrence('every friday')).toEqual({ type: 'weekly-day', dayOfWeek: 5 });
  });

  it('parses "every sunday"', () => {
    expect(parseRecurrence('every sunday')).toEqual({ type: 'weekly-day', dayOfWeek: 0 });
  });

  it('parses "every 2 weeks"', () => {
    expect(parseRecurrence('every 2 weeks')).toEqual({ type: 'every-n-weeks', interval: 2 });
  });

  it('parses "every 1 week"', () => {
    expect(parseRecurrence('every 1 week')).toEqual({ type: 'every-n-weeks', interval: 1 });
  });

  it('parses "monthly"', () => {
    expect(parseRecurrence('monthly')).toEqual({ type: 'monthly' });
  });

  it('parses "every month"', () => {
    expect(parseRecurrence('every month')).toEqual({ type: 'monthly' });
  });

  it('parses "1st of month"', () => {
    expect(parseRecurrence('1st of month')).toEqual({ type: 'nth-of-month', dayOfMonth: 1 });
  });

  it('parses "15th of month"', () => {
    expect(parseRecurrence('15th of month')).toEqual({ type: 'nth-of-month', dayOfMonth: 15 });
  });

  it('parses "2nd of each month"', () => {
    expect(parseRecurrence('2nd of each month')).toEqual({ type: 'nth-of-month', dayOfMonth: 2 });
  });

  it('parses "3rd of month"', () => {
    expect(parseRecurrence('3rd of month')).toEqual({ type: 'nth-of-month', dayOfMonth: 3 });
  });

  it('parses "quarterly"', () => {
    expect(parseRecurrence('quarterly')).toEqual({ type: 'every-n-months', interval: 3 });
  });

  it('parses "every 6 months"', () => {
    expect(parseRecurrence('every 6 months')).toEqual({ type: 'every-n-months', interval: 6 });
  });

  it('parses "every 1 month"', () => {
    expect(parseRecurrence('every 1 month')).toEqual({ type: 'every-n-months', interval: 1 });
  });

  it('returns undefined for unrecognized patterns', () => {
    expect(parseRecurrence('whenever')).toBeUndefined();
    expect(parseRecurrence('')).toBeUndefined();
    expect(parseRecurrence('every other day')).toBeUndefined();
    expect(parseRecurrence('biweekly')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(parseRecurrence('  daily  ')).toEqual({ type: 'daily' });
  });
});

// ---------- isRecurrenceDue ----------

describe('isRecurrenceDue', () => {
  function makeFm(overrides: Partial<NoteFrontmatter> & Record<string, unknown>): NoteFrontmatter {
    return {
      title: 'Test',
      type: 'task',
      status: 'done',
      recurrence: 'daily',
      created: '2026-03-01T10:00:00.000Z',
      modified: '2026-03-10T10:00:00.000Z',
      ...overrides,
    };
  }

  it('returns false when no recurrence field', () => {
    expect(isRecurrenceDue(makeFm({ recurrence: undefined }), new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  it('returns false when status is not done', () => {
    expect(isRecurrenceDue(makeFm({ status: 'active' }), new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  it('returns false for unrecognized recurrence pattern', () => {
    expect(isRecurrenceDue(makeFm({ recurrence: 'bogus' }), new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  it('returns false on the same day as completion (anchor)', () => {
    const fm = makeFm({ 'recurrence-anchor': '2026-03-15' });
    expect(isRecurrenceDue(fm, new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  // Daily
  it('daily: due the day after completion', () => {
    const fm = makeFm({ recurrence: 'daily', 'recurrence-anchor': '2026-03-14T12:00:00' });
    expect(isRecurrenceDue(fm, new Date('2026-03-15T12:00:00'))).toBe(true);
  });

  // Weekday
  it('weekday: due on a Monday', () => {
    const fm = makeFm({ recurrence: 'every weekday', 'recurrence-anchor': '2026-03-13T12:00:00' }); // Friday
    // March 16, 2026 is Monday
    expect(isRecurrenceDue(fm, new Date('2026-03-16T12:00:00'))).toBe(true);
  });

  it('weekday: not due on a Saturday', () => {
    const fm = makeFm({ recurrence: 'every weekday', 'recurrence-anchor': '2026-03-13T12:00:00' });
    // March 14, 2026 is Saturday
    expect(isRecurrenceDue(fm, new Date('2026-03-14T12:00:00'))).toBe(false);
  });

  it('weekday: not due on a Sunday', () => {
    const fm = makeFm({ recurrence: 'every weekday', 'recurrence-anchor': '2026-03-13T12:00:00' });
    // March 15, 2026 is Sunday
    expect(isRecurrenceDue(fm, new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  // Weekly on specific day
  it('weekly-day: due on matching day of week', () => {
    const fm = makeFm({ recurrence: 'every monday', 'recurrence-anchor': '2026-03-09T12:00:00' }); // Monday
    // March 16, 2026 is Monday
    expect(isRecurrenceDue(fm, new Date('2026-03-16T12:00:00'))).toBe(true);
  });

  it('weekly-day: not due on non-matching day', () => {
    const fm = makeFm({ recurrence: 'every monday', 'recurrence-anchor': '2026-03-09T12:00:00' });
    // March 17, 2026 is Tuesday
    expect(isRecurrenceDue(fm, new Date('2026-03-17T12:00:00'))).toBe(false);
  });

  // Every N weeks
  it('every-n-weeks: due after exact interval', () => {
    // Use dates after DST to avoid spring-forward hour loss in diff calculation
    const fm = makeFm({ recurrence: 'every 2 weeks', 'recurrence-anchor': '2026-03-16T12:00:00' }); // Monday
    // 2 weeks later: March 30, 2026 is Monday
    expect(isRecurrenceDue(fm, new Date('2026-03-30T12:00:00'))).toBe(true);
  });

  it('every-n-weeks: not due on wrong week', () => {
    const fm = makeFm({ recurrence: 'every 2 weeks', 'recurrence-anchor': '2026-03-16T12:00:00' });
    // 1 week later: March 23
    expect(isRecurrenceDue(fm, new Date('2026-03-23T12:00:00'))).toBe(false);
  });

  it('every-n-weeks: not due on wrong day of week', () => {
    const fm = makeFm({ recurrence: 'every 2 weeks', 'recurrence-anchor': '2026-03-16T12:00:00' }); // Monday
    // March 31 is Tuesday (right week but wrong day)
    expect(isRecurrenceDue(fm, new Date('2026-03-31T12:00:00'))).toBe(false);
  });

  // Monthly
  it('monthly: due on same day of month, different month', () => {
    const fm = makeFm({ recurrence: 'monthly', 'recurrence-anchor': '2026-03-10T12:00:00' });
    // April 10
    expect(isRecurrenceDue(fm, new Date('2026-04-10T12:00:00'))).toBe(true);
  });

  it('monthly: not due on same day same month', () => {
    const fm = makeFm({ recurrence: 'monthly', 'recurrence-anchor': '2026-03-10T12:00:00' });
    // Same month, different day after anchor
    expect(isRecurrenceDue(fm, new Date('2026-03-20T12:00:00'))).toBe(false);
  });

  // Nth of month
  it('nth-of-month: due on matching day', () => {
    const fm = makeFm({ recurrence: '1st of month', 'recurrence-anchor': '2026-02-15T12:00:00' });
    expect(isRecurrenceDue(fm, new Date('2026-03-01T12:00:00'))).toBe(true);
  });

  it('nth-of-month: not due on non-matching day', () => {
    const fm = makeFm({ recurrence: '1st of month', 'recurrence-anchor': '2026-02-15T12:00:00' });
    expect(isRecurrenceDue(fm, new Date('2026-03-15T12:00:00'))).toBe(false);
  });

  // Every N months
  it('every-n-months: due after exact interval', () => {
    const fm = makeFm({ recurrence: 'quarterly', 'recurrence-anchor': '2026-01-10T12:00:00' });
    // 3 months later: April 10
    expect(isRecurrenceDue(fm, new Date('2026-04-10T12:00:00'))).toBe(true);
  });

  it('every-n-months: not due on wrong month', () => {
    const fm = makeFm({ recurrence: 'quarterly', 'recurrence-anchor': '2026-01-10T12:00:00' });
    // 2 months later: March 10
    expect(isRecurrenceDue(fm, new Date('2026-03-10T12:00:00'))).toBe(false);
  });

  it('every-n-months: not due on wrong day', () => {
    const fm = makeFm({ recurrence: 'quarterly', 'recurrence-anchor': '2026-01-10T12:00:00' });
    // Right month, wrong day
    expect(isRecurrenceDue(fm, new Date('2026-04-15T12:00:00'))).toBe(false);
  });

  // Anchor fallback
  it('falls back to modified date when no recurrence-anchor', () => {
    const fm = makeFm({ 'recurrence-anchor': undefined, modified: '2026-03-10T10:00:00.000Z' });
    expect(isRecurrenceDue(fm, new Date('2026-03-11T12:00:00'))).toBe(true);
  });

  it('falls back to created date when no anchor or modified', () => {
    const fm = makeFm({ 'recurrence-anchor': undefined, modified: undefined, created: '2026-03-10T10:00:00.000Z' });
    expect(isRecurrenceDue(fm, new Date('2026-03-11T12:00:00'))).toBe(true);
  });
});

// ---------- buildCloneFrontmatter ----------

describe('buildCloneFrontmatter', () => {
  it('sets status to inbox', () => {
    const original: NoteFrontmatter = {
      title: 'Recurring Task',
      type: 'task',
      status: 'done',
      recurrence: 'daily',
      created: '2026-03-01T10:00:00.000Z',
    };
    const clone = buildCloneFrontmatter(original);
    expect(clone.status).toBe('inbox');
  });

  it('preserves recurrence pattern', () => {
    const original: NoteFrontmatter = {
      title: 'Weekly Review',
      type: 'task',
      status: 'done',
      recurrence: 'every monday',
      created: '2026-03-01T10:00:00.000Z',
    };
    const clone = buildCloneFrontmatter(original);
    expect(clone.recurrence).toBe('every monday');
  });

  it('updates created and modified to now', () => {
    const original: NoteFrontmatter = {
      title: 'Test',
      type: 'task',
      status: 'done',
      created: '2026-01-01T00:00:00.000Z',
    };
    const before = new Date().toISOString();
    const clone = buildCloneFrontmatter(original);
    expect(clone.created! >= before).toBe(true);
    expect(clone.modified! >= before).toBe(true);
  });

  it('sets recurrence-anchor to today', () => {
    const original: NoteFrontmatter = {
      title: 'Test',
      type: 'task',
      status: 'done',
      recurrence: 'daily',
      'recurrence-anchor': '2026-01-01',
      created: '2026-01-01T00:00:00.000Z',
    };
    const clone = buildCloneFrontmatter(original);
    const today = new Date().toISOString().slice(0, 10);
    expect(clone['recurrence-anchor']).toBe(today);
  });

  it('does not mutate the original', () => {
    const original: NoteFrontmatter = {
      title: 'Test',
      type: 'task',
      status: 'done',
      created: '2026-01-01T00:00:00.000Z',
    };
    buildCloneFrontmatter(original);
    expect(original.status).toBe('done');
  });
});
