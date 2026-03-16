import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { NoteFrontmatter, TaskStatus, GTD_LISTS } from '../vault/types';

/**
 * Manages WYSIWYG editor webview panels for vault notes.
 * Uses EasyMDE (self-contained, no external deps) for markdown editing.
 */
export class EditorPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private onDidSave: (() => void) | undefined;

  constructor(
    private manager: VaultManager,
    private extensionUri: vscode.Uri,
    onDidSave?: () => void
  ) {
    this.onDidSave = onDidSave;
  }

  async openFile(filePath: string): Promise<void> {
    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal();
      return;
    }

    const note = await this.manager.readNote(filePath);
    const fileName = path.basename(filePath, '.md');

    const panel = vscode.window.createWebviewPanel(
      'kbvault.editor',
      note.frontmatter.title ?? fileName,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'easymde', 'dist'),
        ],
      }
    );

    this.panels.set(filePath, panel);

    const editorJsUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'easymde', 'dist', 'easymde.min.js')
    );
    const editorCssUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'easymde', 'dist', 'easymde.min.css')
    );

    panel.webview.html = this.getHtml(panel.webview, editorJsUri, editorCssUri, note.frontmatter, note.body);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'save': {
          const frontmatter: NoteFrontmatter = { ...note.frontmatter, ...msg.frontmatter };
          frontmatter.modified = new Date().toISOString();
          await this.manager.writeNote(filePath, frontmatter, msg.body);
          if (frontmatter.title) panel.title = frontmatter.title;
          vscode.window.showInformationMessage('Note saved.');
          Object.assign(note.frontmatter, frontmatter);
          note.body = msg.body;
          this.onDidSave?.();
          break;
        }
        case 'statusChange': {
          note.frontmatter.status = msg.status;
          note.frontmatter.modified = new Date().toISOString();
          await this.manager.writeNote(filePath, note.frontmatter, note.body);
          vscode.window.showInformationMessage(`Status → ${GTD_LISTS[msg.status as TaskStatus] ?? msg.status}`);
          this.onDidSave?.();
          break;
        }
      }
    });

    panel.onDidDispose(() => {
      this.panels.delete(filePath);
    });
  }

  private getHtml(
    webview: vscode.Webview,
    editorJsUri: vscode.Uri,
    editorCssUri: vscode.Uri,
    frontmatter: NoteFrontmatter,
    body: string
  ): string {
    const nonce = getNonce();
    const statusOptions = Object.entries(GTD_LISTS)
      .map(([k, v]) => `<option value="${k}" ${frontmatter.status === k ? 'selected' : ''}>${v}</option>`)
      .join('');
    const tagsValue = Array.isArray(frontmatter.tags) ? frontmatter.tags.join(', ') : '';
    const contextValue = Array.isArray(frontmatter.context) ? (frontmatter.context as string[]).join(', ') : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data: https:;">
  <link href="${editorCssUri}" rel="stylesheet">
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --border: var(--vscode-panel-border);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--bg);
      color: var(--fg);
    }
    .frontmatter {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px 16px;
      padding: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--input-bg);
    }
    .field { display: flex; flex-direction: column; gap: 2px; }
    .field label {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.7;
      font-weight: 600;
    }
    .field input, .field select {
      padding: 4px 8px;
      background: var(--bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      align-items: center;
    }
    .toolbar button {
      padding: 6px 16px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .toolbar button:hover { background: var(--btn-hover); }
    .toolbar .save-hint {
      opacity: 0.5;
      font-size: 12px;
      margin-left: auto;
    }
    .status-msg {
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.3s;
      color: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
    }
    .status-msg.show { opacity: 1; }

    /* EasyMDE theme overrides to match VSCode */
    .EasyMDEContainer .CodeMirror {
      background: var(--bg) !important;
      color: var(--fg) !important;
      border: 1px solid var(--border) !important;
      border-radius: 0 0 4px 4px;
      font-family: var(--vscode-editor-font-family, 'Menlo, Monaco, monospace');
      font-size: var(--vscode-editor-font-size, 13px);
      min-height: 350px;
    }
    .EasyMDEContainer .CodeMirror-cursor {
      border-left-color: var(--fg) !important;
    }
    .EasyMDEContainer .CodeMirror-selected {
      background: var(--vscode-editor-selectionBackground, rgba(0,120,215,0.3)) !important;
    }
    .EasyMDEContainer .editor-toolbar {
      background: var(--input-bg) !important;
      border: 1px solid var(--border) !important;
      border-bottom: none !important;
      border-radius: 4px 4px 0 0;
      opacity: 1 !important;
    }
    .EasyMDEContainer .editor-toolbar button {
      color: var(--fg) !important;
      border: none !important;
      background: transparent !important;
    }
    .EasyMDEContainer .editor-toolbar button:hover,
    .EasyMDEContainer .editor-toolbar button.active {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)) !important;
      border-radius: 3px;
    }
    .EasyMDEContainer .editor-toolbar i.separator {
      border-left-color: var(--border) !important;
    }
    .EasyMDEContainer .editor-statusbar {
      color: var(--fg) !important;
      opacity: 0.5;
      background: var(--input-bg) !important;
      border-top: 1px solid var(--border) !important;
    }
    .EasyMDEContainer .editor-preview {
      background: var(--bg) !important;
      color: var(--fg) !important;
    }
    .EasyMDEContainer .editor-preview-side {
      background: var(--bg) !important;
      color: var(--fg) !important;
      border-left: 1px solid var(--border) !important;
    }
    /* Rendered markdown styles in preview */
    .editor-preview h1, .editor-preview h2, .editor-preview h3,
    .editor-preview-side h1, .editor-preview-side h2, .editor-preview-side h3 {
      color: var(--fg) !important;
      border-bottom: 1px solid var(--border);
      padding-bottom: 4px;
    }
    .editor-preview code, .editor-preview-side code {
      background: var(--input-bg) !important;
      color: var(--fg) !important;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .editor-preview pre, .editor-preview-side pre {
      background: var(--input-bg) !important;
      border: 1px solid var(--border) !important;
      border-radius: 4px;
      padding: 12px !important;
    }
    .editor-preview a, .editor-preview-side a {
      color: var(--vscode-textLink-foreground, #3794ff) !important;
    }
    .editor-preview blockquote, .editor-preview-side blockquote {
      border-left: 3px solid var(--border) !important;
      color: var(--fg) !important;
      opacity: 0.8;
    }
  </style>
</head>
<body>

<div class="toolbar">
  <button id="save-btn" onclick="save()">💾 Save</button>
  <span class="status-msg" id="status-msg"></span>
  <span class="save-hint">⌘S also works</span>
</div>

<div class="frontmatter">
  <div class="field">
    <label>Title</label>
    <input id="fm-title" value="${escapeAttr(frontmatter.title ?? '')}" />
  </div>
  <div class="field">
    <label>Type</label>
    <select id="fm-type">
      <option value="note" ${frontmatter.type === 'note' ? 'selected' : ''}>Note</option>
      <option value="task" ${frontmatter.type === 'task' ? 'selected' : ''}>Task</option>
      <option value="reference" ${frontmatter.type === 'reference' ? 'selected' : ''}>Reference</option>
    </select>
  </div>
  <div class="field">
    <label>Status</label>
    <select id="fm-status" onchange="statusChanged()">${statusOptions}</select>
  </div>
  <div class="field">
    <label>Priority</label>
    <select id="fm-priority">
      <option value="low" ${frontmatter.priority === 'low' ? 'selected' : ''}>Low</option>
      <option value="medium" ${frontmatter.priority === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="high" ${frontmatter.priority === 'high' ? 'selected' : ''}>High</option>
    </select>
  </div>
  <div class="field">
    <label>Context</label>
    <input id="fm-context" value="${escapeAttr(contextValue)}" placeholder="@computer, @phone" />
  </div>
  <div class="field">
    <label>Project</label>
    <input id="fm-project" value="${escapeAttr(frontmatter.project ?? '')}" />
  </div>
  <div class="field">
    <label>Tags</label>
    <input id="fm-tags" value="${escapeAttr(tagsValue)}" placeholder="tag1, tag2" />
  </div>
  <div class="field">
    <label>Due</label>
    <input id="fm-due" type="date" value="${escapeAttr(frontmatter.due ?? '')}" />
  </div>
</div>

<textarea id="md-editor">${escapeHtml(body.trim())}</textarea>

<script nonce="${nonce}" src="${editorJsUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let statusTimer;

  function showStatus(msg) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // Initialize EasyMDE
  const editor = new EasyMDE({
    element: document.getElementById('md-editor'),
    initialValue: '',
    autofocus: true,
    spellChecker: false,
    status: ['lines', 'words', 'cursor'],
    toolbar: [
      'bold', 'italic', 'strikethrough', '|',
      'heading-1', 'heading-2', 'heading-3', '|',
      'unordered-list', 'ordered-list', 'checklist', '|',
      'quote', 'code', '|',
      'link', 'image', 'table', 'horizontal-rule', '|',
      'preview', 'side-by-side', '|',
      'guide'
    ],
    renderingConfig: {
      codeSyntaxHighlighting: false,
    },
    previewClass: ['editor-preview'],
  });

  function gatherFrontmatter() {
    return {
      title: document.getElementById('fm-title').value,
      type: document.getElementById('fm-type').value,
      status: document.getElementById('fm-status').value,
      priority: document.getElementById('fm-priority').value,
      context: document.getElementById('fm-context').value
        .split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      project: document.getElementById('fm-project').value || undefined,
      tags: document.getElementById('fm-tags').value
        .split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      due: document.getElementById('fm-due').value || undefined,
    };
  }

  function save() {
    vscode.postMessage({
      type: 'save',
      frontmatter: gatherFrontmatter(),
      body: editor.value(),
    });
    showStatus('✓ Saved');
  }

  function statusChanged() {
    const status = document.getElementById('fm-status').value;
    vscode.postMessage({
      type: 'statusChange',
      status: status,
    });
    showStatus('Status updated');
  }

  // Ctrl/Cmd+S to save
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
</script>

</body>
</html>`;
  }

  disposeAll(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
