import * as vscode from 'vscode';
import * as path from 'path';
import { VaultManager } from '../vault/manager';
import { NoteFrontmatter, TaskStatus, GTD_LISTS } from '../vault/types';

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
    if (existing) { existing.reveal(); return; }

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
          vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'marked', 'lib'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'turndown', 'lib'),
        ],
      }
    );

    this.panels.set(filePath, panel);

    const markedUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js')
    );
    const turndownUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'turndown', 'lib', 'turndown.umd.js')
    );

    panel.webview.html = this.getHtml(panel.webview, markedUri, turndownUri, note.frontmatter, note.body);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'save') {
        const frontmatter: NoteFrontmatter = { ...note.frontmatter, ...msg.frontmatter };
        frontmatter.modified = new Date().toISOString();
        await this.manager.writeNote(filePath, frontmatter, msg.body);
        if (frontmatter.title) panel.title = frontmatter.title;
        Object.assign(note.frontmatter, frontmatter);
        note.body = msg.body;
        this.onDidSave?.();
      }
      if (msg.type === 'statusChange') {
        note.frontmatter.status = msg.status;
        note.frontmatter.modified = new Date().toISOString();
        await this.manager.writeNote(filePath, note.frontmatter, note.body);
        vscode.window.showInformationMessage(`Status → ${GTD_LISTS[msg.status as TaskStatus] ?? msg.status}`);
        this.onDidSave?.();
      }
    });

    panel.onDidDispose(() => this.panels.delete(filePath));
  }

  private getHtml(
    webview: vscode.Webview,
    markedUri: vscode.Uri,
    turndownUri: vscode.Uri,
    frontmatter: NoteFrontmatter,
    body: string
  ): string {
    const nonce = getNonce();
    const statusOptions = Object.entries(GTD_LISTS)
      .map(([k, v]) => `<option value="${k}" ${frontmatter.status === k ? 'selected' : ''}>${v}</option>`)
      .join('');
    const tagsValue = Array.isArray(frontmatter.tags) ? frontmatter.tags.join(', ') : '';
    const contextValue = Array.isArray(frontmatter.context) ? (frontmatter.context as string[]).join(', ') : '';
    // Pass body as JSON so it survives all escaping in the script block
    const bodyJson = JSON.stringify(body.trim());

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:;">
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --input-bg: var(--vscode-input-background, #2d2d2d);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --border: var(--vscode-panel-border, #444);
      --toolbar-hover: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
      --accent: var(--vscode-textLink-foreground, #3794ff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Top bar ── */
    #topbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--input-bg);
      flex-shrink: 0;
    }
    #topbar button {
      padding: 3px 10px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    #topbar button:hover { background: var(--btn-hover); }
    #save-hint { font-size: 11px; opacity: 0.45; margin-left: 4px; }
    #save-status { font-size: 11px; color: var(--accent); opacity: 0; transition: opacity 0.3s; margin-left: auto; }
    #save-status.show { opacity: 1; }

    /* ── Frontmatter card ── */
    #fm-card {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 6px 14px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--input-bg);
      flex-shrink: 0;
    }
    .field { display: flex; flex-direction: column; gap: 2px; }
    .field label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: 0.55; font-weight: 600; }
    .field input, .field select {
      background: var(--bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      font-family: inherit;
    }
    .field input:focus, .field select:focus { outline: 1px solid var(--accent); }

    /* ── Editor toolbar ── */
    #editor-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--input-bg);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    #editor-toolbar button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      color: var(--fg);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 6px;
      min-width: 26px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #editor-toolbar button:hover { background: var(--toolbar-hover); border-color: var(--border); }
    #editor-toolbar button[title] { position: relative; }
    .tb-sep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }

    /* ── WYSIWYG content area ── */
    #editor {
      flex: 1;
      overflow-y: auto;
      padding: 20px 28px;
      outline: none;
      line-height: 1.7;
      font-size: 14px;
    }
    /* Rendered content styles */
    #editor h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: .3em; margin: .67em 0 .5em; }
    #editor h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: .2em; margin: .75em 0 .5em; }
    #editor h3 { font-size: 1.25em; margin: .75em 0 .4em; }
    #editor h4, #editor h5, #editor h6 { margin: .75em 0 .4em; }
    #editor p { margin: .5em 0; }
    #editor ul, #editor ol { padding-left: 1.5em; margin: .5em 0; }
    #editor li { margin: .2em 0; }
    #editor input[type=checkbox] { margin-right: 6px; }
    #editor blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 12px;
      margin: .5em 0;
      opacity: 0.75;
    }
    #editor code {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 5px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .9em;
    }
    #editor pre {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      overflow-x: auto;
      margin: .5em 0;
    }
    #editor pre code { background: none; border: none; padding: 0; }
    #editor a { color: var(--accent); }
    #editor hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
    #editor table { border-collapse: collapse; margin: .5em 0; width: 100%; }
    #editor th, #editor td { border: 1px solid var(--border); padding: 5px 10px; }
    #editor th { background: var(--input-bg); font-weight: 600; }
    /* Placeholder */
    #editor:empty:before {
      content: 'Start writing…';
      opacity: 0.3;
      pointer-events: none;
    }
  </style>
</head>
<body>

<div id="topbar">
  <button id="save-btn">Save</button>
  <span id="save-hint">⌘S</span>
  <span id="save-status">✓ Saved</span>
</div>

<div id="fm-card">
  <div class="field">
    <label>Title</label>
    <input id="fm-title" value="${escapeAttr(frontmatter.title ?? '')}" />
  </div>
  <div class="field">
    <label>Status</label>
    <select id="fm-status">${statusOptions}</select>
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
    <label>Priority</label>
    <select id="fm-priority">
      <option value="low" ${frontmatter.priority === 'low' ? 'selected' : ''}>Low</option>
      <option value="medium" ${frontmatter.priority === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="high" ${frontmatter.priority === 'high' ? 'selected' : ''}>High</option>
    </select>
  </div>
  <div class="field">
    <label>Project</label>
    <input id="fm-project" value="${escapeAttr(frontmatter.project ?? '')}" />
  </div>
  <div class="field">
    <label>Context</label>
    <input id="fm-context" value="${escapeAttr(contextValue)}" placeholder="@home, @computer" />
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

<div id="editor-toolbar">
  <button data-cmd="bold"        title="Bold (⌘B)"><b>B</b></button>
  <button data-cmd="italic"      title="Italic (⌘I)"><i>I</i></button>
  <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
  <div class="tb-sep"></div>
  <button data-heading="1"  title="Heading 1">H1</button>
  <button data-heading="2"  title="Heading 2">H2</button>
  <button data-heading="3"  title="Heading 3">H3</button>
  <div class="tb-sep"></div>
  <button data-cmd="insertUnorderedList" title="Bullet list">• —</button>
  <button data-cmd="insertOrderedList"   title="Numbered list">1.</button>
  <button data-task title="Task list (checklist)">☑</button>
  <div class="tb-sep"></div>
  <button data-cmd="formatBlock" data-val="blockquote" title="Quote">❝</button>
  <button data-code title="Inline code">{ }</button>
  <div class="tb-sep"></div>
  <button data-link title="Insert link">🔗</button>
  <button data-hr title="Horizontal rule">—</button>
</div>

<div id="editor" contenteditable="true" spellcheck="true"></div>

<script nonce="${nonce}" src="${markedUri}"></script>
<script nonce="${nonce}" src="${turndownUri}"></script>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const editorEl = document.getElementById('editor');
  const saveStatus = document.getElementById('save-status');
  let saveTimer;

  // ── Load initial content ──────────────────────────────────────────────────
  const initialMarkdown = ${bodyJson};
  editorEl.innerHTML = marked.parse(initialMarkdown || '');

  // ── Turndown instance (HTML → Markdown) ──────────────────────────────────
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  // Preserve task list checkboxes
  td.addRule('taskListItem', {
    filter: function(node) {
      return node.nodeName === 'LI' && node.querySelector('input[type=checkbox]');
    },
    replacement: function(content, node) {
      const cb = node.querySelector('input[type=checkbox]');
      const checked = cb && cb.checked ? '[x]' : '[ ]';
      const text = content.replace(/^\s*\[.\]\s*/, '').trim();
      return '- ' + checked + ' ' + text + '\\n';
    }
  });

  // ── Save ─────────────────────────────────────────────────────────────────
  function showSaved() {
    saveStatus.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() { saveStatus.classList.remove('show'); }, 2500);
  }

  function gatherFrontmatter() {
    return {
      title:    document.getElementById('fm-title').value,
      type:     document.getElementById('fm-type').value,
      status:   document.getElementById('fm-status').value,
      priority: document.getElementById('fm-priority').value,
      project:  document.getElementById('fm-project').value || undefined,
      context:  document.getElementById('fm-context').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean),
      tags:     document.getElementById('fm-tags').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean),
      due:      document.getElementById('fm-due').value || undefined,
    };
  }

  function doSave() {
    const markdown = td.turndown(editorEl.innerHTML);
    vscode.postMessage({ type: 'save', frontmatter: gatherFrontmatter(), body: markdown });
    showSaved();
  }

  document.getElementById('save-btn').addEventListener('click', doSave);

  document.getElementById('fm-status').addEventListener('change', function() {
    vscode.postMessage({ type: 'statusChange', status: this.value });
    showSaved();
  });

  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      doSave();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      document.execCommand('bold');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
      e.preventDefault();
      document.execCommand('italic');
    }
  });

  // ── Toolbar ──────────────────────────────────────────────────────────────
  document.getElementById('editor-toolbar').addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;

    editorEl.focus();

    if (btn.dataset.cmd) {
      var val = btn.dataset.val || null;
      document.execCommand(btn.dataset.cmd, false, val);
      return;
    }

    if (btn.dataset.heading) {
      document.execCommand('formatBlock', false, 'h' + btn.dataset.heading);
      return;
    }

    if (btn.hasAttribute('data-task')) {
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        var range = sel.getRangeAt(0);
        var li = document.createElement('li');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        var span = document.createElement('span');
        span.textContent = ' ';
        li.appendChild(cb);
        li.appendChild(span);
        var ul = document.createElement('ul');
        ul.appendChild(li);
        range.insertNode(ul);
        // Move cursor to span
        var r = document.createRange();
        r.setStart(span, 1);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      return;
    }

    if (btn.hasAttribute('data-code')) {
      var sel2 = window.getSelection();
      if (sel2 && sel2.toString().length > 0) {
        document.execCommand('insertHTML', false, '<code>' + sel2.toString() + '</code>');
      } else {
        document.execCommand('insertHTML', false, '<code>code</code>');
      }
      return;
    }

    if (btn.hasAttribute('data-link')) {
      var url = prompt('URL:');
      if (url) document.execCommand('createLink', false, url);
      return;
    }

    if (btn.hasAttribute('data-hr')) {
      document.execCommand('insertHorizontalRule');
      return;
    }
  });

})();
</script>
</body>
</html>`;
  }

  disposeAll(): void {
    for (const panel of this.panels.values()) panel.dispose();
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
