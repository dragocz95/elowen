// Files plugin: read/write/list, each confined to the caller's accessible repos via ctx.assertPathAllowed
// (which reads the per-session Policy). A guard rejection is returned as an error text so the model can
// react, not thrown, matching how the elowen_* tools surface API errors.
import { defineTool, withFileMutationQueue, truncateHead, formatSize } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const DEFAULT_MAX = 100_000;
const DEFAULT_SEARCH_MAX_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 5_000;
const DIFF_CONTEXT = 3;
const DIFF_MAX_LINES = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'web-dist', '.next', '.turbo']);
const execFileP = promisify(execFile);
const ok = (tool, text, details = {}) => ({
  content: [{ type: 'text', text }],
  details: { ok: true, tool, truncated: false, ...details },
});
const fail = (tool, e, details = {}) => ok(tool, `Error: ${e instanceof Error ? e.message : String(e)}`, {
  ok: false,
  error: { message: e instanceof Error ? e.message : String(e) },
  ...details,
});
/** Line-aware head truncation via PI's shared util. readCap maps to maxBytes, with no line cap so the
 *  config knob stays purely byte-based. truncateHead never splits a line, so a single line longer than the
 *  cap yields empty content (firstLineExceedsLimit) — fall back to a UTF-8-safe byte slice of that line so a
 *  minified/one-line file still shows its head. The hint carries how much was shown vs. the full size. */
const truncate = (text, maxBytes = DEFAULT_MAX) => {
  const r = truncateHead(text, { maxBytes, maxLines: Infinity });
  if (!r.truncated) return { text: r.content, truncated: false };
  const shown = r.firstLineExceedsLimit ? sliceBytes(text, maxBytes) : r.content;
  const shownLines = r.firstLineExceedsLimit ? 1 : r.outputLines;
  const hint = `…[truncated: showing ${formatSize(Buffer.byteLength(shown))} of ${formatSize(r.totalBytes)}, ${shownLines}/${r.totalLines} lines]`;
  return { text: `${shown}\n${hint}`, truncated: true };
};

/** Slice `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
function sliceBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // back up to a UTF-8 char boundary
  return buf.subarray(0, end).toString('utf-8');
}

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

function safeRegex(query) {
  try { return new RegExp(query, 'i'); }
  catch { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

function safeRegexSource(query) {
  try { new RegExp(query); return query; }
  catch { return String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

function globRegex(glob) {
  if (!glob) return null;
  const source = String(glob);
  let escaped = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '*') {
      if (source[i + 1] === '*') { escaped += '.*'; i += 1; }
      else escaped += '[^/]*';
    } else if (ch === '{') {
      const close = source.indexOf('}', i + 1);
      if (close > i + 1) {
        const variants = source.slice(i + 1, close).split(',').filter(Boolean);
        escaped += `(?:${variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
      } else {
        escaped += '\\{';
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      escaped += `\\${ch}`;
    } else {
      escaped += ch;
    }
  }
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root, limit = 5000) {
  const s = statSync(root);
  if (s.isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name));
      } else if (ent.isFile()) {
        out.push(join(dir, ent.name));
      }
    }
  };
  walk(root);
  return out;
}

async function rgSearch(abs, root, queryText, include, mode, maxMatches) {
  const ignoreGlobs = [...SKIP_DIRS].map((d) => `!${d}/**`);
  if (mode === 'files') {
    const args = ['--files', ...ignoreGlobs.flatMap((g) => ['--glob', g]), ...(include ? ['--glob', include] : []), abs];
    const { stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 1_000_000 });
    const query = safeRegex(queryText);
    return stdout.split('\n').filter(Boolean)
      .map((p) => relative(root, p.startsWith('/') ? p : join(root, p)) || p)
      .filter((p) => query.test(p))
      .slice(0, maxMatches);
  }
  const args = [
    '--line-number', '--with-filename', '--color', 'never', '--no-heading', '-i',
    ...ignoreGlobs.flatMap((g) => ['--glob', g]),
    ...(include ? ['--glob', include] : []),
    '--',
    safeRegexSource(queryText),
    abs,
  ];
  try {
    const { stdout } = await execFileP('rg', args, { cwd: root, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 1_000_000 });
    return stdout.split('\n').filter(Boolean).map((line) => {
      if (!line.startsWith('/')) return line;
      const first = line.indexOf(':');
      const second = first >= 0 ? line.indexOf(':', first + 1) : -1;
      if (second < 0) return line;
      return `${relative(root, line.slice(0, first))}${line.slice(first)}`;
    }).slice(0, maxMatches);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 1) return [];
    throw e;
  }
}

export function register(ctx) {
  const readCap = Math.min(Math.max(Number(ctx.config.readCap) || DEFAULT_MAX, 20_000), 500_000);
  const searchMaxMatches = Math.min(Math.max(Number(ctx.config.searchMaxMatches) || DEFAULT_SEARCH_MAX_MATCHES, 50), 1000);

  ctx.registerTool(defineTool({
    name: 'read_file', label: 'Read file',
    description: [
      'Read a UTF-8 text file within the accessible repositories.',
      'Use when you need exact source text, config, logs, or docs before editing.',
      'Do not use for broad discovery; use search_files or list_dir first.',
      'Input requires an absolute path. Output is file text and may be truncated; details.truncated tells you if more targeted reads are needed.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String({ description: 'Absolute path to the UTF-8 text file' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const body = readFileSync(abs, 'utf-8');
        const out = truncate(body, readCap);
        return ok('read_file', out.text, { path: abs, bytes: Buffer.byteLength(body), truncated: out.truncated });
      } catch (e) { return fail('read_file', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'write_file', label: 'Write file',
    description: [
      'Create or overwrite a UTF-8 text file within the accessible repositories.',
      'Use only when you intend to replace the full file content.',
      'Prefer edit_file for localized changes. Output includes a human summary and details.diff for UI/review.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        // Serialize the read-modify-write against other mutations of the SAME file (different files still
        // run in parallel) so a concurrent edit can't slip between the diff-baseline read and the write.
        return await withFileMutationQueue(abs, async () => {
          let before = null;
          try { before = readFileSync(abs, 'utf-8'); } catch { /* new file */ }
          writeFileSync(abs, p.content, 'utf-8');
          const diff = overwriteDiff(before, p.content);
          return ok('write_file', `Wrote ${Buffer.byteLength(p.content)} bytes to ${abs}`, { path: abs, bytes: Buffer.byteLength(p.content), ...(diff ? { diff } : {}) });
        });
      } catch (e) { return fail('write_file', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'edit_file', label: 'Edit file',
    description: [
      'Replace an exact text snippet in a UTF-8 file within the accessible repositories.',
      'Use for targeted edits after reading enough surrounding context.',
      'oldText must match exactly, including whitespace. By default it must match exactly once; set replaceAll only when every occurrence should change.',
      'Output includes details.diff for review. If oldText is missing or ambiguous, read the file again and provide more context.',
    ].join(' '),
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the file' }),
      oldText: Type.String({ description: 'Exact text to replace' }),
      newText: Type.String({ description: 'Replacement text' }),
      replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence (default false)' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        // Serialize the read-modify-write against other mutations of the SAME file (different files still
        // run in parallel) so a concurrent write can't slip between the match read and the write.
        return await withFileMutationQueue(abs, async () => {
          const before = readFileSync(abs, 'utf-8');
          if (p.oldText === p.newText) return ok('edit_file', 'Error: oldText and newText are identical.', { ok: false, path: abs });
          const first = before.indexOf(p.oldText);
          if (first < 0) return ok('edit_file', 'Error: oldText not found in the file. Match it exactly, including whitespace.', { ok: false, path: abs });
          const count = before.split(p.oldText).length - 1;
          if (count > 1 && !p.replaceAll) return ok('edit_file', `Error: oldText matches ${count} times. Provide more context to make it unique, or set replaceAll.`, { ok: false, path: abs, matches: count });
          const after = p.replaceAll ? before.split(p.oldText).join(p.newText) : `${before.slice(0, first)}${p.newText}${before.slice(first + p.oldText.length)}`;
          writeFileSync(abs, after, 'utf-8');
          const diff = p.replaceAll && count > 1 ? overwriteDiff(before, after) : replacementDiff(before, first, p.oldText, p.newText);
          return ok('edit_file', `Edited ${abs} (${count > 1 ? `${count} replacements` : '1 replacement'})`, { path: abs, replacements: p.replaceAll ? count : 1, diff });
        });
      } catch (e) { return fail('edit_file', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'list_dir', label: 'List directory',
    description: [
      'List the entries of a directory within the accessible repositories.',
      'Use for focused navigation when you already know the directory.',
      'Do not use recursively; use search_files for codebase-wide discovery.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const entries = readdirSync(abs).map((n) => {
          try { return statSync(join(abs, n)).isDirectory() ? `${n}/` : n; } catch { return n; }
        });
        return ok('list_dir', entries.join('\n') || '(empty)', { path: abs, count: entries.length });
      } catch (e) { return fail('list_dir', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'search_files', label: 'Search files',
    description: [
      'Search file names or UTF-8 file contents within an accessible repository path.',
      'Use for codebase discovery before reading or editing files. Prefer content mode for symbols/text and files mode for path/name lookup.',
      'Input path must be an accessible directory or file. Output is grouped matches with line numbers and is capped; details.truncated indicates more specific searches are needed.',
    ].join(' '),
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to search within' }),
      query: Type.String({ description: 'Literal text or regular expression to search for' }),
      mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('files')], { description: 'Search content (default) or file names' })),
      include: Type.Optional(Type.String({ description: 'Optional file glob, e.g. "*.ts", "**/*.tsx", or "*.{ts,tsx}"' })),
    }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const mode = p.mode === 'files' ? 'files' : 'content';
        if (!String(p.query ?? '').trim()) return ok('search_files', 'Error: query is required.', { ok: false, path: abs });
        const root = statSync(abs).isDirectory() ? abs : dirname(abs);
        const queryText = String(p.query);
        const query = safeRegex(queryText);
        const include = globRegex(p.include);
        const lines = [];
        try {
          lines.push(...await rgSearch(abs, root, queryText, p.include, mode, searchMaxMatches));
        } catch {
          // rg is optional on user machines. Fall back to a bounded JS walk when it is unavailable/errors.
        }
        for (const file of lines.length ? [] : walkFiles(abs)) {
          const rel = relative(root, file) || file;
          if (include && !include.test(rel) && !include.test(rel.split('/').at(-1) ?? rel)) continue;
          if (mode === 'files') {
            if (query.test(rel)) lines.push(rel);
            if (lines.length >= searchMaxMatches) break;
            continue;
          }
          let body = '';
          try { body = readFileSync(file, 'utf-8'); } catch { continue; }
          const fileLines = body.split('\n');
          for (let i = 0; i < fileLines.length; i++) {
            if (!query.test(fileLines[i])) continue;
            lines.push(`${rel}:${i + 1}: ${fileLines[i]}`);
            if (lines.length >= searchMaxMatches) break;
          }
          if (lines.length >= searchMaxMatches) break;
        }
        const formatted = lines.join('\n');
        const truncated = lines.length >= searchMaxMatches;
        return ok('search_files', formatted || 'No matches found.', { path: abs, mode, matches: lines.length, truncated });
      } catch (e) { return fail('search_files', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'file_info', label: 'File info',
    description: [
      'Inspect basic filesystem metadata for a file or directory inside accessible repositories.',
      'Use to verify existence, size, file type, and modification time before reading a large file or writing changes.',
      'Output is JSON so it can be parsed by the model.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String({ description: 'Absolute path to inspect' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const s = statSync(abs);
        const info = { path: abs, type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', bytes: s.size, modifiedAt: s.mtime.toISOString() };
        return ok('file_info', JSON.stringify(info, null, 2), info);
      } catch (e) { return fail('file_info', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'git_status', label: 'Git status',
    description: [
      'Report concise git repository state for an accessible project path.',
      'Use before/after edits to understand branch, dirty files, and staged changes.',
      'Do not use for arbitrary shell commands; it only runs safe git status/rev-parse commands.',
    ].join(' '),
    parameters: Type.Object({ path: Type.String({ description: 'Absolute repository path or file path inside it' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const cwd = statSync(abs).isDirectory() ? abs : dirname(abs);
        const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const root = run(['rev-parse', '--show-toplevel']);
        ctx.assertPathAllowed(root);
        const branch = run(['branch', '--show-current']) || run(['rev-parse', '--short', 'HEAD']);
        const porcelain = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const lines = porcelain.split('\n').filter(Boolean);
        const out = [`branch ${branch}`, `root ${root}`, lines.length ? '' : 'clean', ...lines.slice(0, 120)];
        return ok('git_status', out.join('\n'), { root, branch, dirtyFiles: lines.length, truncated: lines.length > 120 });
      } catch (e) { return fail('git_status', e); }
    },
  }));

  ctx.logger.info('registered read_file, write_file, edit_file, list_dir, search_files, file_info, git_status');
}
