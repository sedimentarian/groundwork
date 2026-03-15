import { VaultStore } from './store';
import {
  VaultManagerConfig,
  VaultScope,
  ParsedNote,
  NoteFrontmatter,
  VaultFile,
  SessionEntry,
} from './types';

export class VaultManager {
  private global: VaultStore;
  private workspace: VaultStore | undefined;
  private config: VaultManagerConfig;

  constructor(config: VaultManagerConfig) {
    this.config = { ...config };
    this.global = new VaultStore(config.globalPath, 'global');
    if (config.workspacePath) {
      this.workspace = new VaultStore(config.workspacePath, 'workspace');
    }
  }

  get globalStore(): VaultStore {
    return this.global;
  }

  get workspaceStore(): VaultStore | undefined {
    return this.workspace;
  }

  get globalPath(): string {
    return this.config.globalPath;
  }

  get workspacePath(): string | undefined {
    return this.config.workspacePath;
  }

  /** Initialize both vault roots */
  async init(): Promise<void> {
    await this.global.init();
    if (this.workspace) {
      await this.workspace.init();
    }
  }

  /** Initialize workspace vault on demand (creates .kbvault/ in workspace) */
  async initWorkspace(workspacePath: string): Promise<void> {
    this.config.workspacePath = workspacePath;
    this.workspace = new VaultStore(workspacePath, 'workspace');
    await this.workspace.init();
  }

  /** List files from both vaults, workspace items first */
  async listFiles(scope?: VaultScope): Promise<VaultFile[]> {
    if (scope === 'global') return this.global.listFiles();
    if (scope === 'workspace') {
      return this.workspace ? this.workspace.listFiles() : [];
    }

    // Merge both — workspace first
    const globalFiles = await this.global.listFiles();
    const workspaceFiles = this.workspace
      ? await this.workspace.listFiles()
      : [];
    return [...workspaceFiles, ...globalFiles];
  }

  /** Query notes from both vaults, deduplicating by relativePath (workspace wins) */
  async queryNotes(
    filter: Partial<NoteFrontmatter>,
    scope?: VaultScope
  ): Promise<ParsedNote[]> {
    if (scope === 'global') return this.global.queryNotes(filter);
    if (scope === 'workspace') {
      return this.workspace ? this.workspace.queryNotes(filter) : [];
    }

    const globalNotes = await this.global.queryNotes(filter);
    const workspaceNotes = this.workspace
      ? await this.workspace.queryNotes(filter)
      : [];

    // Workspace wins on duplicate relativePath
    const seen = new Set<string>();
    const merged: ParsedNote[] = [];

    for (const note of workspaceNotes) {
      seen.add(note.relativePath);
      merged.push(note);
    }
    for (const note of globalNotes) {
      if (!seen.has(note.relativePath)) {
        merged.push(note);
      }
    }

    return merged;
  }

  /** Read a note — delegates to the correct store based on path */
  async readNote(filePath: string): Promise<ParsedNote> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.readNote(filePath);
    }
    return this.global.readNote(filePath);
  }

  /** Write a note — delegates to the correct store based on path */
  async writeNote(
    filePath: string,
    frontmatter: NoteFrontmatter,
    body: string
  ): Promise<void> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.writeNote(filePath, frontmatter, body);
    }
    return this.global.writeNote(filePath, frontmatter, body);
  }

  /** Delete a note */
  async delete(filePath: string): Promise<void> {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) {
      return this.workspace.delete(filePath);
    }
    return this.global.delete(filePath);
  }

  /** Log a session — always to global store */
  async logSession(entry: SessionEntry): Promise<void> {
    return this.global.logSession(entry);
  }

  /** Get recent sessions — from global store */
  async getRecentSessions(days?: number): Promise<SessionEntry[]> {
    return this.global.getRecentSessions(days);
  }

  /** Check if a file path belongs to either vault */
  isVaultFile(filePath: string): boolean {
    if (filePath.startsWith(this.global.rootDir)) return true;
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) return true;
    return false;
  }

  /** Determine which scope a file belongs to */
  scopeOf(filePath: string): VaultScope | undefined {
    if (this.workspace && filePath.startsWith(this.workspace.rootDir)) return 'workspace';
    if (filePath.startsWith(this.global.rootDir)) return 'global';
    return undefined;
  }

  /** Get the store for a given scope */
  storeFor(scope: VaultScope): VaultStore | undefined {
    return scope === 'workspace' ? this.workspace : this.global;
  }

  /** Get root dir for a given scope */
  rootDirFor(scope: VaultScope): string | undefined {
    return scope === 'workspace' ? this.workspace?.rootDir : this.global.rootDir;
  }
}
