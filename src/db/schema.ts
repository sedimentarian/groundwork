import { GroundworkDB } from './index';

export const SCHEMA_VERSION = 1;

const NOTES_TABLE = `
CREATE TABLE IF NOT EXISTS notes (
  path          TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  title         TEXT,
  type          TEXT,
  status        TEXT,
  priority      TEXT,
  sort_order    INTEGER,
  due           TEXT,
  project       TEXT,
  context       TEXT,
  tags          TEXT,
  recurrence    TEXT,
  created       TEXT,
  modified      TEXT,
  body_hash     TEXT,
  indexed_at    TEXT,
  schema_version INTEGER DEFAULT ${SCHEMA_VERSION}
)`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_type_status ON notes(type, status)',
  'CREATE INDEX IF NOT EXISTS idx_due ON notes(due)',
  'CREATE INDEX IF NOT EXISTS idx_project ON notes(project)',
  'CREATE INDEX IF NOT EXISTS idx_scope ON notes(scope)',
];

// Standalone FTS4 table (not content-synced) — managed via explicit insert/delete in queries.ts
const FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts4(
  path,
  title,
  body
)`;

// No triggers — FTS rows are managed by upsertNote/deleteNote in queries.ts
const FTS_TRIGGERS: string[] = [];

const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`;

/** Initialize or rebuild the schema. Drops and recreates if version mismatches. */
export function initSchema(db: GroundworkDB): void {
  // Check existing schema version
  try {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    if (row && Number(row.value) === SCHEMA_VERSION) {
      return; // Schema is current
    }
    // Version mismatch — drop everything and rebuild
    dropAll(db);
  } catch {
    // meta table doesn't exist — fresh DB
  }

  db.run(NOTES_TABLE);
  for (const idx of INDEXES) db.run(idx);
  db.run(FTS_TABLE);
  for (const trigger of FTS_TRIGGERS) db.run(trigger);
  db.run(META_TABLE);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}

function dropAll(db: GroundworkDB): void {
  // Drop in reverse dependency order
  db.run('DROP TRIGGER IF EXISTS notes_ai');
  db.run('DROP TRIGGER IF EXISTS notes_ad');
  db.run('DROP TRIGGER IF EXISTS notes_au');
  db.run('DROP TABLE IF EXISTS notes_fts');
  db.run('DROP TABLE IF EXISTS notes');
  db.run('DROP TABLE IF EXISTS meta');
}
