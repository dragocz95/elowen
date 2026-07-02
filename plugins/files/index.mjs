// Files plugin: read/write/list, each confined to the caller's accessible repos via ctx.assertPathAllowed
// (which reads the per-session Policy). A guard rejection is returned as an error text so the model can
// react, not thrown, matching how the orca_* tools surface API errors.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 100_000;
const DIFF_CONTEXT = 3;
const DIFF_MAX_LINES = 200;
const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** One numbered diff row in pi's display format (sign first, so pi's renderDiff can color it with
 *  intra-line highlighting): `-   12 old` / `+   13 new` / `    11 context`. */
const diffRow = (n, sign, text) => `${sign}${String(n).padStart(5)} ${text}`;

/** Build a numbered display diff for a localized replacement: context, removed, added, context. */
export function replacementDiff(before, matchIndex, oldText, newText) {
  const startLine = before.slice(0, matchIndex).split('\n').length; // 1-based first changed row
  const all = before.split('\n');
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const rows = [];
  for (let i = Math.max(0, startLine - 1 - DIFF_CONTEXT); i < startLine - 1; i++) rows.push(diffRow(i + 1, ' ', all[i]));
  oldLines.forEach((l, i) => rows.push(diffRow(startLine + i, '-', l)));
  newLines.forEach((l, i) => rows.push(diffRow(startLine + i, '+', l)));
  const afterStart = startLine - 1 + oldLines.length;
  for (let i = afterStart; i < Math.min(all.length, afterStart + DIFF_CONTEXT); i++) {
    rows.push(diffRow(i + 1 - oldLines.length + newLines.length, ' ', all[i]));
  }
  return rows.slice(0, DIFF_MAX_LINES).join('\n');
}

/** Whole-file diff for an overwrite: common prefix/suffix stay context, the middle flips -/+.
 *  A brand-new file (before = null) renders as all-added lines. */
export function overwriteDiff(before, after) {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const rows = [];
  for (let i = Math.max(0, head - DIFF_CONTEXT); i < head; i++) rows.push(diffRow(i + 1, ' ', a[i]));
  for (let i = head; i < a.length - tail; i++) rows.push(diffRow(i + 1, '-', a[i]));
  for (let i = head; i < b.length - tail; i++) rows.push(diffRow(i + 1, '+', b[i]));
  for (let i = b.length - tail; i < Math.min(b.length, b.length - tail + DIFF_CONTEXT); i++) rows.push(diffRow(i + 1, ' ', b[i]));
  return rows.slice(0, DIFF_MAX_LINES).join('\n');
}

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'read_file', label: 'Read file',
    description: 'Read a UTF-8 text file within your accessible repositories.',
    parameters: Type.Object({ path: Type.String({ description: 'Absolute path to the file' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const body = readFileSync(abs, 'utf-8');
        return ok(body.length > MAX ? `${body.slice(0, MAX)}\n…[truncated]` : body);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'write_file', label: 'Write file',
    description: 'Create or overwrite a UTF-8 text file within your accessible repositories.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        let before = null;
        try { before = readFileSync(abs, 'utf-8'); } catch { /* new file */ }
        writeFileSync(abs, p.content, 'utf-8');
        const diff = overwriteDiff(before, p.content);
        return ok(`Wrote ${Buffer.byteLength(p.content)} bytes to ${abs}`, diff ? { diff } : {});
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'edit_file', label: 'Edit file',
    description: 'Replace an exact text snippet in a UTF-8 file within your accessible repositories. '
      + 'oldText must match the file content exactly (including whitespace) and exactly once, '
      + 'unless replaceAll is true.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the file' }),
      oldText: Type.String({ description: 'Exact text to replace' }),
      newText: Type.String({ description: 'Replacement text' }),
      replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence (default false)' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const before = readFileSync(abs, 'utf-8');
        if (p.oldText === p.newText) return ok('Error: oldText and newText are identical.');
        const first = before.indexOf(p.oldText);
        if (first < 0) return ok('Error: oldText not found in the file. Match it exactly, including whitespace.');
        const count = before.split(p.oldText).length - 1;
        if (count > 1 && !p.replaceAll) return ok(`Error: oldText matches ${count} times. Provide more context to make it unique, or set replaceAll.`);
        const after = p.replaceAll ? before.split(p.oldText).join(p.newText) : `${before.slice(0, first)}${p.newText}${before.slice(first + p.oldText.length)}`;
        writeFileSync(abs, after, 'utf-8');
        const diff = p.replaceAll && count > 1 ? overwriteDiff(before, after) : replacementDiff(before, first, p.oldText, p.newText);
        return ok(`Edited ${abs} (${count > 1 ? `${count} replacements` : '1 replacement'})`, { diff });
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'list_dir', label: 'List directory',
    description: 'List the entries of a directory within your accessible repositories.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const entries = readdirSync(abs).map((n) => {
          try { return statSync(join(abs, n)).isDirectory() ? `${n}/` : n; } catch { return n; }
        });
        return ok(entries.join('\n') || '(empty)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info('registered read_file, write_file, edit_file, list_dir');
}
