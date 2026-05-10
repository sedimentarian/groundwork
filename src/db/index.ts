import * as fs from 'fs';
import * as path from 'path';

// sql.js types — runtime loaded from vendored lib/ build
interface SqlJsDatabase {
  run(sql: string, params?: any[]): SqlJsDatabase;
  exec(sql: string): { columns: string[]; values: any[][] }[];
  prepare(sql: string): { bind(params?: any[]): boolean; step(): boolean; getAsObject(params?: object): Record<string, unknown>; free(): boolean };
  export(): Uint8Array;
  close(): void;
}
interface SqlJsStatic { Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase; }

let SQL: SqlJsStatic | null = null;

export class GroundworkDB {
  private db: SqlJsDatabase | null = null;

  constructor(private dbPath: string) {}

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open or create the database. Loads WASM on first call. */
  async open(): Promise<void> {
    if (!SQL) {
      // Load vendored sql.js build from lib/ (custom build with FTS5 enabled).
      // Both sql-wasm.js and sql-wasm.wasm must come from the same build.
      const libPaths = [
        path.join(__dirname, '..', 'lib'),
        path.join(__dirname, '..', '..', 'lib'),
      ];
      let initSqlJs: ((opts?: { wasmBinary?: ArrayLike<number> | Buffer }) => Promise<SqlJsStatic>) | undefined;
      let wasmBinary: Buffer | undefined;

      for (const libDir of libPaths) {
        try {
          initSqlJs = require(path.join(libDir, 'sql-wasm.js'));
          wasmBinary = fs.readFileSync(path.join(libDir, 'sql-wasm.wasm'));
          break;
        } catch { /* try next */ }
      }

      if (!initSqlJs || !wasmBinary) {
        throw new Error(`sql-wasm.js/wasm not found in lib/. Checked: ${libPaths.join(', ')}`);
      }

      SQL = await initSqlJs({ wasmBinary });
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
