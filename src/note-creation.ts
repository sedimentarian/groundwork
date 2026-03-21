import * as vscode from 'vscode';
import { NoteFrontmatter } from './vault/types';

// ── Templates ───────────────────────────────────────────────────────────────

interface NoteTemplate {
  label: string;
  description: string;
  noteType: NoteFrontmatter['type'];
  body: (title: string) => string;
}

const TEMPLATES: Record<string, NoteTemplate> = {
  decision: {
    label: '⚖️ Decision Log',
    description: 'Document a decision with options and rationale',
    noteType: 'decision',
    body: (title) => `
# ${title}

## Context
What is the background? What problem are we solving?

## Options Considered

### Option 1: [Name]
- **Pros:**
- **Cons:**

### Option 2: [Name]
- **Pros:**
- **Cons:**

## Decision
What was decided and why?

## Consequences
What are the implications of this decision?
`,
  },

  design: {
    label: '📐 Design Note',
    description: 'Document a design with approach and tradeoffs',
    noteType: 'reference',
    body: (title) => `
# ${title}

## Overview
What is this about? What problem does it solve?

## Design

### Approach
Describe the chosen approach.

### Key Components
-

### Data Flow
How does data move through the system?

## Tradeoffs
What was traded off and why?

## References
-
`,
  },

  meeting: {
    label: '🗓 Meeting Notes',
    description: 'Attendees, agenda, decisions, action items',
    noteType: 'note',
    body: (title) => {
      const today = new Date().toISOString().slice(0, 10);
      return `
# ${title}

**Date:** ${today}
**Attendees:**

## Agenda
1.

## Discussion

## Decisions
-

## Action Items
- [ ]
`;
    },
  },

  project: {
    label: '🚀 Project Kickoff',
    description: 'Goals, scope, dependencies, risks, timeline',
    noteType: 'project',
    body: (title) => `
# ${title}

## Goals
What does success look like?

## Scope

### In Scope
-

### Out of Scope
-

## Dependencies
-

## Risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
|      |           |        |            |

## Timeline
| Milestone | Target Date |
|-----------|-------------|
|           |             |
`,
  },

  reference: {
    label: '📚 Reference Doc',
    description: 'Summary, details, examples',
    noteType: 'reference',
    body: (title) => `
# ${title}

## Summary


## Details


## Examples


## Related
-
`,
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

export interface NoteCreationResult {
  body: string;
  noteType: NoteFrontmatter['type'];
}

/**
 * Presents the user with note creation options: blank, template, or AI-generated.
 * Returns the note body and type, or undefined if cancelled.
 *
 * @param title - The note title
 * @param getActiveContext - Lazy getter for current work context (only called for AI path)
 */
export async function pickNoteCreationMethod(
  title: string,
  getActiveContext?: () => Promise<string>
): Promise<NoteCreationResult | undefined> {
  const choices = [
    { label: '✏️  Blank Note', description: 'Start with an empty note', value: 'blank' as const },
    { label: '📋  From Template…', description: 'Pre-filled structure', value: 'template' as const },
    { label: '🤖  Generate with AI…', description: 'Copilot or clipboard prompt', value: 'ai' as const },
  ];

  const method = await vscode.window.showQuickPick(choices, {
    placeHolder: 'How would you like to create this note?',
  });
  if (!method) return undefined;

  switch (method.value) {
    case 'blank':
      return { body: `\n# ${title}\n\n`, noteType: 'note' };

    case 'template':
      return await pickTemplate(title);

    case 'ai':
      return await generateWithAI(title, getActiveContext);
  }
}

// ── Task creation ──────────────────────────────────────────────────────────

export interface TaskCreationResult {
  body: string;
}

/**
 * Presents the user with task body options: blank or AI-generated.
 * Returns the task body, or undefined if cancelled.
 */
export async function pickTaskCreationMethod(
  title: string,
  getActiveContext?: () => Promise<string>
): Promise<TaskCreationResult | undefined> {
  const choices = [
    { label: '✏️  Blank', description: 'Start with an empty task', value: 'blank' as const },
    { label: '🤖  Generate with AI…', description: 'AI breaks down the task', value: 'ai' as const },
  ];

  const method = await vscode.window.showQuickPick(choices, {
    placeHolder: 'How would you like to create this task?',
  });
  if (!method) return undefined;

  switch (method.value) {
    case 'blank':
      return { body: `\n${title}\n\n## Notes\n\n` };

    case 'ai':
      return await generateTaskWithAI(title, getActiveContext);
  }
}

async function generateTaskWithAI(
  title: string,
  getActiveContext?: () => Promise<string>
): Promise<TaskCreationResult | undefined> {
  const description = await vscode.window.showInputBox({
    prompt: 'Any extra context for the AI? (optional — press Enter to skip)',
    placeHolder: 'e.g., needs to support pagination, deadline is Friday',
  });
  // Allow empty string (user pressed Enter with no input)
  if (description === undefined) return undefined;

  let activeContext: string | undefined;
  if (getActiveContext) {
    try {
      activeContext = await getActiveContext();
    } catch {
      // Non-critical
    }
  }

  const prompt = buildTaskPrompt(title, description, activeContext);

  // Try VSCode Language Model API
  const lm = (vscode as any).lm;
  if (lm && typeof lm.selectChatModels === 'function') {
    try {
      let models = await lm.selectChatModels({ family: 'gpt-4o' });
      if (!models || models.length === 0) {
        models = await lm.selectChatModels({});
      }
      if (models && models.length > 0) {
        const result = await callLanguageModelForTask(models[0], prompt);
        if (result) return result;
      }
    } catch {
      // Fall through to clipboard
    }
  }

  // Fallback: copy prompt to clipboard
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    'AI prompt copied to clipboard — paste into Claude or Copilot chat, then paste the result into the editor.'
  );
  return {
    body: `\n${title}\n\n> **Paste AI-generated breakdown here.** The generation prompt is on your clipboard.\n\n`,
  };
}

function buildTaskPrompt(title: string, description: string, activeContext?: string): string {
  let prompt = `Break down this task into a clear, actionable plan in markdown format.

Task: ${title}${description ? `\nAdditional context: ${description}` : ''}

Requirements:
- Start with a brief one-line summary of what this task involves
- Add a "## Steps" section with a numbered list of concrete steps
- Add a "## Acceptance Criteria" section with a bulleted checklist (using - [ ])
- If relevant, add a "## Notes" section for gotchas, dependencies, or open questions
- Be specific and practical — avoid vague or generic steps
- Output ONLY the markdown body — no YAML frontmatter, no wrapping code fences`;

  if (activeContext && !activeContext.includes('No active or next tasks')) {
    prompt += `

Here is the author's current work context — use it to make the breakdown relevant:
${activeContext}`;
  }

  return prompt;
}

async function callLanguageModelForTask(
  model: any,
  prompt: string
): Promise<TaskCreationResult | undefined> {
  const LMChatMessage = (vscode as any).LanguageModelChatMessage;
  if (!LMChatMessage) return undefined;

  const messages = [LMChatMessage.User(prompt)];

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating task breakdown with AI…',
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        const response = await model.sendRequest(messages, {}, token);
        let result = '';
        for await (const chunk of response.text) {
          if (token.isCancellationRequested) return undefined;
          result += chunk;
        }
        result = result.replace(/^```(?:markdown|md)?\n/i, '').replace(/\n```\s*$/, '');
        return { body: '\n' + result.trim() + '\n' };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes('denied') || msg.includes('permission') || msg.includes('consent')) {
          vscode.window.showInformationMessage(
            'Copilot permission required. Falling back to clipboard prompt.'
          );
        }
        return undefined;
      }
    }
  );
}

// ── Template picker ─────────────────────────────────────────────────────────

async function pickTemplate(title: string): Promise<NoteCreationResult | undefined> {
  const items = Object.entries(TEMPLATES).map(([key, tmpl]) => ({
    label: tmpl.label,
    description: tmpl.description,
    value: key,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a template',
  });
  if (!picked) return undefined;

  const template = TEMPLATES[picked.value];
  return {
    body: template.body(title),
    noteType: template.noteType,
  };
}

// ── AI generation ───────────────────────────────────────────────────────────

async function generateWithAI(
  title: string,
  getActiveContext?: () => Promise<string>
): Promise<NoteCreationResult | undefined> {
  const description = await vscode.window.showInputBox({
    prompt: 'Describe what this note should cover',
    placeHolder: 'e.g., Redis caching strategy for our API layer, comparing approaches',
  });
  if (!description) return undefined;

  // Gather active context lazily — only now that we need it
  let activeContext: string | undefined;
  if (getActiveContext) {
    try {
      activeContext = await getActiveContext();
    } catch {
      // Non-critical — continue without context
    }
  }

  const prompt = buildPrompt(title, description, activeContext);

  // Try VSCode Language Model API (requires Copilot or compatible LM extension)
  const lm = (vscode as any).lm;
  if (lm && typeof lm.selectChatModels === 'function') {
    try {
      let models = await lm.selectChatModels({ family: 'gpt-4o' });
      if (!models || models.length === 0) {
        models = await lm.selectChatModels({});
      }
      if (models && models.length > 0) {
        const result = await callLanguageModel(models[0], prompt);
        if (result) return result;
      }
    } catch {
      // LM API available but failed — fall through to clipboard
    }
  }

  // Fallback: copy prompt to clipboard
  return await promptToClipboard(title, prompt);
}

function buildPrompt(title: string, description: string, activeContext?: string): string {
  let prompt = `Create a detailed reference note in markdown format.

Title: ${title}
Topic: ${description}

Requirements:
- Start with a level-1 heading (# ${title})
- Use clear subheadings (##, ###) to organize the content
- Be specific and actionable — avoid generic filler
- Include concrete examples where appropriate
- Output ONLY the markdown body — no YAML frontmatter, no wrapping code fences`;

  if (activeContext && !activeContext.includes('No active or next tasks')) {
    prompt += `

Here is the author's current work context for reference — use it to make the note relevant:
${activeContext}`;
  }

  return prompt;
}

async function callLanguageModel(
  model: any,
  prompt: string
): Promise<NoteCreationResult | undefined> {
  const LMChatMessage = (vscode as any).LanguageModelChatMessage;
  if (!LMChatMessage) return undefined;

  const messages = [LMChatMessage.User(prompt)];

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating note with AI…',
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        const response = await model.sendRequest(messages, {}, token);
        let result = '';
        for await (const chunk of response.text) {
          if (token.isCancellationRequested) return undefined;
          result += chunk;
        }
        // Strip markdown code fences if the model wrapped the output
        result = result.replace(/^```(?:markdown|md)?\n/i, '').replace(/\n```\s*$/, '');
        return { body: '\n' + result.trim() + '\n', noteType: 'reference' as const };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes('denied') || msg.includes('permission') || msg.includes('consent')) {
          vscode.window.showInformationMessage(
            'Copilot permission required. Falling back to clipboard prompt.'
          );
        }
        return undefined; // signal to fall through to clipboard
      }
    }
  );
}

async function promptToClipboard(
  title: string,
  prompt: string
): Promise<NoteCreationResult> {
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    'AI prompt copied to clipboard — paste into Claude or Copilot chat, then paste the result into the editor.'
  );
  return {
    body: `\n# ${title}\n\n> **Paste AI-generated content here.** The generation prompt is on your clipboard.\n\n`,
    noteType: 'note',
  };
}
