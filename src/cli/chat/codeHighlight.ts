/** Syntax highlighting for the terminal chat, shared by the diff renderer and Markdown code blocks.
 *  shiki/core with the JavaScript regex engine (no WASM) and the Monokai palette — the vivid, saturated
 *  colours Claude Code uses (pink/cyan/green/purple/yellow on a near-black bg), so highlighted code POPS
 *  on the dark diff backgrounds. Grammars lazy-loaded per language so startup cost stays near zero.
 *  Rendering is always synchronous: a line whose grammar is not loaded yet falls back to the
 *  unhighlighted path, and the registered listener triggers one re-render once the grammar lands. */

import { visibleWidth } from '@earendil-works/pi-tui';
import { createHighlighterCore } from 'shiki/core';
import type { HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/** One styled fragment of a source line. `fg` is a ready-to-use SGR parameter set (`38;2;r;g;b`),
 *  pre-converted from the theme's hex so the diff renderer can composite it over a row background. */
export interface CodeToken {
  text: string;
  fg: string;
}

/** Monokai's default foreground (#F8F8F2), used when shiki reports no explicit token color. */
const DEFAULT_FG = '38;2;248;248;242';
const THEME = 'monokai';

/** Languages worth loading eagerly at chat start — the ones an agent diff touches every session. */
const PREWARM_LANGS = ['typescript', 'tsx', 'javascript', 'json', 'bash', 'markdown', 'python', 'css', 'html', 'yaml'] as const;

/** Static loader map: explicit per-language dynamic imports keep tsc's type resolution intact and the
 *  running daemon pays the grammar file only for languages actually seen. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  vue: () => import('shiki/dist/langs/vue.mjs'),
  svelte: () => import('shiki/dist/langs/svelte.mjs'),
  bash: () => import('shiki/dist/langs/bash.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  cpp: () => import('shiki/dist/langs/cpp.mjs'),
  csharp: () => import('shiki/dist/langs/csharp.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  php: () => import('shiki/dist/langs/php.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  lua: () => import('shiki/dist/langs/lua.mjs'),
  r: () => import('shiki/dist/langs/r.mjs'),
  ini: () => import('shiki/dist/langs/ini.mjs'),
  terraform: () => import('shiki/dist/langs/terraform.mjs'),
};

/** File extension (lowercase, no dot) → shiki language id. */
const EXT_TO_LANG: Record<string, string> = {
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

/** Markdown fence aliases → shiki language id (fence names differ from file extensions: `ts`, `py`…). */
const FENCE_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', python: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', bash: 'bash',
  yml: 'yaml', rb: 'ruby', cs: 'csharp', kt: 'kotlin', docker: 'dockerfile',
  'c++': 'cpp', 'c#': 'csharp', golang: 'go', rs: 'rust',
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
    const lang = EXT_TO_LANG[base.slice(dot + 1).toLowerCase()];
    if (lang) return lang;
  }
  return null;
}

/** The shiki language for a Markdown fence info string (`json`, `ts`, `python`…), or null. */
export function langForFence(info: string | null | undefined): string | null {
  if (!info) return null;
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!name) return null;
  if (name in LANG_LOADERS) return name;
  return FENCE_TO_LANG[name] ?? EXT_TO_LANG[name] ?? null;
}

const hexToFgParams = (hex: string | undefined): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return DEFAULT_FG;
  const n = parseInt(m[1]!, 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighter: HighlighterCore | null = null;
const loadedLangs = new Set<string>();
const pendingLangs = new Map<string, Promise<void>>();
const readyListeners = new Set<() => void>();

/** Register (or, with a null argument, clear) a re-render hook fired whenever a newly loaded grammar
 *  can change the picture. Listeners are held in a Set so two coexisting compositions each get their
 *  own hook instead of overwriting one slot; `setCodeHighlightListener(null)` clears all of them, and
 *  the returned function unregisters just the one that was added. */
export function setCodeHighlightListener(cb: (() => void) | null): () => void {
  if (cb == null) { readyListeners.clear(); return () => {}; }
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

function notifyReady(): void {
  for (const cb of readyListeners) cb();
}

function ensureHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('shiki/dist/themes/monokai.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }).then((h) => {
      highlighter = h;
      return h;
    });
  }
  return highlighterPromise;
}

/** Kick an async grammar load. Safe to call per render: deduped per language, failures leave the
 *  unhighlighted fallback in place. Returns the load promise so tests can await determinism. */
export function ensureLang(lang: string): Promise<void> | null {
  if (!LANG_LOADERS[lang] || loadedLangs.has(lang)) return null;
  const existing = pendingLangs.get(lang);
  if (existing) return existing;
  const promise = (async () => {
    const h = await ensureHighlighter();
    await h.loadLanguage(LANG_LOADERS[lang]!() as never);
    loadedLangs.add(lang);
    notifyReady();
  })()
    .catch(() => { /* highlighting simply stays off for this language */ })
    .finally(() => { pendingLangs.delete(lang); });
  pendingLangs.set(lang, promise);
  return promise;
}

/** Pre-warm the everyday grammars in the background; rendering never waits on this. */
export function prewarmCodeHighlight(): void {
  for (const lang of PREWARM_LANGS) void ensureLang(lang);
}

/** Bounded FIFO token cache: diff rows re-render every frame, tokenization must happen once per
 *  (language, line). 500 entries covers a large diff plus the visible Markdown code blocks. */
const CACHE_LIMIT = 500;
const tokenCache = new Map<string, CodeToken[] | null>();

/** Bounded FIFO cache for whole-fence renders. A streaming code block re-renders every 250 ms tick;
 *  keying the ANSI result by `${lang}\n${code}` makes that a map hit instead of a full re-tokenize. */
const BLOCK_CACHE_LIMIT = 200;
const blockCache = new Map<string, string[] | null>();

function tokenize(line: string, lang: string): CodeToken[] | null {
  if (!highlighter || !loadedLangs.has(lang)) return null;
  try {
    const rows = highlighter.codeToTokensBase(line, { lang, theme: THEME });
    const tokens = rows[0];
    if (!tokens) return null;
    return tokens.map((t) => ({ text: t.content, fg: hexToFgParams(t.color) }));
  } catch {
    return null;
  }
}

/** Tokenize one source line, or null when the grammar is not loaded yet (or the language is
 *  unknown) — the caller renders its plain path then. Per-line tokenization is deliberately
 *  stateless: diff hunks are fragments, so a multi-line construct may mis-color at hunk edges. */
export function highlightLine(line: string, lang: string): CodeToken[] | null {
  if (!line || !LANG_LOADERS[lang]) return null;
  // The unloaded state is transient: caching its null would poison the cache so the line never
  // highlights once the grammar lands and the re-render fires. Check it BEFORE the cache and return
  // null uncached; only real tokenization results (tokens or null-from-error) are memoized.
  if (!highlighter || !loadedLangs.has(lang)) return null;
  const key = `${lang} ${line}`;
  if (tokenCache.has(key)) return tokenCache.get(key)!;
  const tokens = tokenize(line, lang);
  if (tokenCache.size >= CACHE_LIMIT) {
    for (const oldest of [...tokenCache.keys()].slice(0, CACHE_LIMIT / 2)) tokenCache.delete(oldest);
  }
  tokenCache.set(key, tokens);
  return tokens;
}

/** Render a whole code block (Markdown fence) as ANSI lines with per-token foregrounds — the
 *  `MarkdownTheme.highlightCode` shape. Returns null when the grammar is unavailable, so the caller
 *  keeps its previous styling for that block. */
export function highlightBlock(code: string, lang: string): string[] | null {
  if (!LANG_LOADERS[lang]) return null;
  ensureLang(lang);
  // The unloaded state is transient — never cache its null, or the block would stay plain after the
  // grammar lands (mirrors highlightLine). Only memoize real tokenization results.
  if (!highlighter || !loadedLangs.has(lang)) return null;
  const key = `${lang}\n${code}`;
  if (blockCache.has(key)) return blockCache.get(key)!;
  let result: string[] | null;
  try {
    const rows = highlighter.codeToTokensBase(code.replace(/\n+$/, ''), { lang, theme: THEME });
    result = rows.map((tokens) =>
      `${tokens.map((t) => `\x1b[${hexToFgParams(t.color)}m${t.content}`).join('')}\x1b[0m`);
  } catch {
    result = null;
  }
  if (blockCache.size >= BLOCK_CACHE_LIMIT) {
    for (const oldest of [...blockCache.keys()].slice(0, BLOCK_CACHE_LIMIT / 2)) blockCache.delete(oldest);
  }
  blockCache.set(key, result);
  return result;
}

/** Wrap tokenized source into visual rows of at most `width` cells, splitting tokens at the wrap
 *  point so a long logical line keeps correct colors on every continuation row. */
export function wrapTokens(tokens: readonly CodeToken[], width: number): CodeToken[][] {
  // Measure each grapheme with the same visibleWidth pi-tui uses for row padding, so a non-Latin line
  // wraps at the exact column its diff row later pads to — a homemade codePoint heuristic disagreed
  // with paintTokenRow and made CJK source wrap early and pad to the wrong column.
  const charWidth = (ch: string): number => visibleWidth(ch);
  const rows: CodeToken[][] = [[]];
  let col = 0;
  for (const token of tokens) {
    let rest = token.text;
    while (rest.length > 0) {
      if (col >= width) {
        rows.push([]);
        col = 0;
      }
      let take = 0;
      let w = 0;
      for (const ch of rest) {
        const cw = charWidth(ch);
        if (col + w + cw > width) break;
        w += cw;
        take += ch.length;
      }
      if (take === 0) {
        // A single glyph wider than the remaining room moves to the next row — but only if this row
        // already holds something. On an empty row (glyph wider than the ENTIRE width) force-place it
        // so the loop always makes progress instead of pushing empty rows forever.
        if (col > 0) {
          rows.push([]);
          col = 0;
          continue;
        }
        const first = [...rest][0]!;
        rows[rows.length - 1]!.push({ text: first, fg: token.fg });
        col += charWidth(first);
        rest = rest.slice(first.length);
        continue;
      }
      rows[rows.length - 1]!.push({ text: rest.slice(0, take), fg: token.fg });
      col += w;
      rest = rest.slice(take);
    }
  }
  return rows;
}
