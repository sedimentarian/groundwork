/** Frontmatter parsed from a markdown file */
export interface NoteFrontmatter {
  title?: string;
  type?: 'note' | 'task' | 'project' | 'reference' | 'decision' | 'log';
  status?: TaskStatus;
  context?: string[];    // GTD contexts: @computer, @phone, etc.
  project?: string;      // Parent project name
  tags?: string[];
  created?: string;      // ISO date
  modified?: string;     // ISO date
  due?: string;          // ISO date
  priority?: 'high' | 'medium' | 'low';
  recurrence?: string;         // daily | weekday | weekly | monthly | quarterly
  'recurrence-anchor'?: string; // ISO date — anchor for interval calculation
  'sort-order'?: number;       // Numeric sort key for custom ordering
  [key: string]: unknown;
}

export type TaskStatus = 'inbox' | 'next' | 'active' | 'waiting' | 'someday' | 'done' | 'cancelled';

export const GTD_LISTS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  next: 'Next Actions',
  active: 'Active',
  waiting: 'Waiting For',
  someday: 'Someday / Maybe',
  done: 'Done',
  cancelled: 'Cancelled',
};

export interface VaultFile {
  /** Absolute path on disk */
  path: string;
  /** Path relative to vault root */
  relativePath: string;
  name: string;
  isDirectory: boolean;
  children?: VaultFile[];
  source: VaultScope;
  /** Frontmatter title, populated by listFiles() for markdown files */
  title?: string;
  /** Frontmatter type, populated by listFiles() for markdown files */
  noteType?: string;
}

export interface ParsedNote {
  path: string;
  relativePath: string;
  frontmatter: NoteFrontmatter;
  body: string;
  raw: string;
  source: VaultScope;
}

export interface SessionEntry {
  timestamp: string;
  action: 'open' | 'save' | 'create' | 'status_change' | 'context_compile' | 'activity_log';
  file?: string;
  detail?: string;
}

/** Which vault root a file belongs to */
export type VaultScope = 'global' | 'workspace';

/** Configuration for VaultManager */
export interface VaultManagerConfig {
  globalPath: string;
  workspacePath?: string;
}
