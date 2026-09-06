/** Mirror of `src/shared/codeDiff.ts`, which is the canonical copy — the diff-row format and the
 *  file→language map the CLI chat and the web chat must read identically.
 *
 *  It is duplicated rather than imported because Turbopack's root is pinned to `web/` (next.config.ts), so
 *  nothing outside this directory resolves at runtime; `tests/contract/codeDiffMirror.test.ts` fails the
 *  moment the two bodies drift. Edit the canonical file first. */

/** File extension (lowercase, no dot) → shiki language id. */
export const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', md: 'markdown', markdown: 'markdown', py: 'python',
  rs: 'rust', go: 'go', css: 'css', html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
  java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  xml: 'xml', svg: 'xml', diff: 'diff', patch: 'diff',
  lua: 'lua', r: 'r', ini: 'ini', cfg: 'ini', tf: 'terraform',
};

/** The shiki language for a file path (a tool-call detail), or null when the extension is unknown —
 *  null keeps the plain unhighlighted rendering, which beats a wrong grammar. */
export function langForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  // Scan whitespace-separated tokens for the FIRST that names a known file: a tool detail like
  // `src/app.ts (+5 -2)` carries the path first and a trailing parenthetical the naive last-token
  // form would pick up instead. Strip surrounding punctuation/parentheses before mapping.
  for (const raw of path.trim().split(/\s+/)) {
    const token = raw.replace(/^[([{'"`]+/, '').replace(/[)\]}'"`,.;:]+$/, '');
    const base = token.split('/').pop() ?? '';
    if (!base) continue;
    if (/^(dockerfile|containerfile)$/i.test(base)) return 'dockerfile';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) continue;
    // `Object.hasOwn`, not a plain lookup: an extension of `constructor` or `toString` would otherwise
    // resolve through Object's prototype and be returned as a language.
    const ext = base.slice(dot + 1).toLowerCase();
    if (Object.hasOwn(EXT_TO_LANG, ext)) return EXT_TO_LANG[ext]!;
  }
  return null;
}

/** One parsed row of a display diff: its sign, the source line number it carries (empty when the row
 *  has none) and the source text with the diff framing removed. */
export interface DiffRow {
  sign: '+' | '-' | ' ';
  num: string;
  text: string;
}

/** `-   12 text` — the current pi-format row: sign first, then the line number. */
const PI_ROW = /^([-+ ])\s*(\d+) (.*)$/;
/** `  12 - text` — rows stored by older builds, line number first. */
const LEGACY_ROW = /^\s*(\d+) ([-+ ]) (.*)$/;
/** `+text` — a bare unified row with no line number. `+++ b/file` and `--- a/file` are unified FILE
 *  HEADERS, not content, so a run of three is excluded and stays an unsigned row. */
const BARE_ROW = /^([-+])(?!\1\1)(.*)$/;

/** Split one display-diff line into sign, line number and source text, or null when the line is not a
 *  diff row at all (a hunk header, a summary line) — the caller renders those plain. */
export function parseDiffRow(line: string): DiffRow | null {
  const pi = PI_ROW.exec(line);
  const legacy = LEGACY_ROW.exec(line);
  // A legacy row with a left-padded line number ('   2 - old') ALSO matches PI_ROW — but with a blank
  // sign, which would strip its add/delete colouring and leak the real '-'/'+' into the rendered text.
  // Prefer the legacy parse whenever PI's sign is meaningless (no PI match, or a blank PI sign).
  if (legacy && (pi == null || pi[1] === ' ')) {
    return { sign: legacy[2] as DiffRow['sign'], num: legacy[1]!, text: legacy[3]! };
  }
  if (pi) return { sign: pi[1] as DiffRow['sign'], num: pi[2]!, text: pi[3]! };
  const bare = BARE_ROW.exec(line);
  if (bare) return { sign: bare[1] as DiffRow['sign'], num: '', text: bare[2]! };
  return null;
}
