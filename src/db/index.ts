import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export class GroundworkDB {
  private db: Database | null = null;

  constructor(private dbPath: string) {}

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open or create the database. Loads WASM on first call. */
  async open(): Promise<void> {
    if (!SQL) {
      // Locate WASM binary relative to this file (works in both dev and packaged extension)
      const wasmPaths = [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ];
      let wasmBinary: Buffer | undefined;
      for (const p of wasmPaths) {
        try {
          wasmBinary = fs.readFileSync(p);
          break;
        } catch { /* try next */ }
      }
      SQL = await initSqlJs(wasmBinary ? { wasmBinary } : undefined);
    }

    try {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.db = new SQL.Database();
    }
  }

  /** Execute a SQL statement (no return value). */
  run(sql: string, params?: unknown[]): void {
    this.assertOpen();
    this.db!.run(sql, params as any[]);
  }

  /** Execute a query and return all rows as typed objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this.assertOpen();
    const stmt = this.db!.prepare(sql);
    if (params) stmt.bind(params as any[]);

    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  /** Execute a query and return the first row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const rows = this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Save the in-memory database to disk. */
  saveToDisk(): void {
    this.assertOpen();
    const data = this.db!.export();
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private assertOpen(): void {
    if (!this.db) throw new Error('Database is not open. Call open() first.');
  }
}
