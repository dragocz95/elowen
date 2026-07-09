// Codebase plugin: a SEMANTIC code index. It chunks the caller's accessible repos, embeds each chunk via
// the SHARED text→vector pipeline (ctx.embeddings — the operator's ONE Settings→Memory embedding model,
// gated by a `reads:['embeddings']` capability), and stores vectors in a plugin-owned SQLite index at
// ctx.dataDir()/index.db. codebase_search then cosine-ranks chunks by MEANING (unlike the files plugin's
// lexical search_files). The index is per-REPO and plugin-owned — it never touches the user-scoped memory
// store. Every disk read + every returned path is confined to the session's repos via ctx.assertPathAllowed.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── defaults (all overridable via configSchema) ──────────────────────────────────────────────────────
const DEFAULT_INCLUDE = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.py', '**/*.go', '**/*.rs',
  '**/*.java', '**/*.rb', '**/*.php', '**/*.c', '**/*.h', '**/*.cpp', '**/*.hpp', '**/*.cs', '**/*.swift',
  '**/*.kt', '**/*.scala', '**/*.sh', '**/*.sql', '**/*.vue', '**/*.svelte', '**/*.css', '**/*.scss',
  '**/*.md', '**/*.mdx', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml',
];
const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'web-dist', '.next', '.git', '.turbo', 'build', 'vendor', '.venv'];
const DEFAULT_CHUNK_MAX_CHARS = 1500;
const DEFAULT_CHUNK_MAX_LINES = 40;
const DEFAULT_TOP_K = 8;
const DEFAULT_RELEVANCE_FLOOR = 0.3; // mirrors memoryService MIN_SEMANTIC — tunable (code may score differently)
const DEFAULT_EMBED_BUDGET = 200;    // chunks embedded per pass, so a big repo spreads across passes
const AUTO_REINDEX_DEBOUNCE_MS = 5 * 60_000; // don't auto-reindex a repo more often than this
const MAX_FILES = 20_000;            // hard cap on files walked per repo
const MINIFIED_MAX_LINE = 5_000;     // a file with a longer single line is treated as minified/binary → skipped
const SNIPPET_MAX_LINES = 6;
const SNIPPET_MAX_CHARS = 400;

// ── tool result idiom (never throw — return the error as text, like the files plugin) ────────────────
const ok = (tool, text, details = {}) => ({
  content: [{ type: 'text', text }],
  details: { ok: true, tool, ...details },
});
const fail = (tool, e, details = {}) => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  details: { ok: false, tool, error: { message: e instanceof Error ? e.message : String(e) }, ...details },
});

// ── pure helpers (exported for unit tests) ───────────────────────────────────────────────────────────

/** sha256 hex of a UTF-8 string — content hash for staleness + chunk identity. Mirrors memoryStore.hashBody. */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Pack a Float32 vector into a raw little-endian BLOB (mirrors memoryStore.packVector: copy the exact
 *  bytes of the view, honoring byteOffset/length). A Buffer is stored as-is. */
export function packVector(vec) {
  if (Buffer.isBuffer(vec)) return vec;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a little-endian BLOB back to a Float32Array (mirrors memoryStore.listActiveWithEmbeddings:
 *  slice to a fresh ArrayBuffer so the view isn't tied to the Buffer's byteOffset). */
export function unpackVector(buf) {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Cosine similarity of two vectors — 0 on a length mismatch or a zero-norm input (mirrors
 *  memoryService.cosine). Pure math; inlining it here is not a duplication of the embedding INFRA (that
 *  is the vector-compute, reused via ctx.embeddings). */
export function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const clampNum = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

/** A best-effort enclosing symbol for a chunk: the nearest declaration/heading at or above `startIdx`.
 *  Cheap regex only (no parser). Returns null when nothing recognizable is found. */
function matchSymbol(line) {
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
    /\bdef\s+([A-Za-z0-9_]+)/,
    /\b(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/,
    /\b(?:pub\s+)?(?:struct|impl|trait|fn)\s+([A-Za-z0-9_]+)/,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$<>,\s]*=>)/,
  ];
  for (const re of patterns) { const m = re.exec(line); if (m) return m[1]; }
  return null;
}

function enclosingSymbol(lines, startIdx, isMd) {
  for (let i = startIdx; i >= 0 && i > startIdx - 400; i--) {
    const line = lines[i];
    if (isMd) {
      const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) return h[1].trim().slice(0, 80);
    } else {
      const s = matchSymbol(line);
      if (s) return s;
    }
  }
  return null;
}

/** Split a file into code-aware chunks. Contiguous, 1-based line ranges that cover every line exactly
 *  once (chunk[i].endLine + 1 === chunk[i+1].startLine). Each chunk is bounded by `chunkMaxChars` and
 *  ~`chunkMaxLines` lines, preferring a blank-line boundary inside the window so a chunk rarely splits a
 *  logical block. `symbol` is a best-effort enclosing declaration/heading. Trailing whitespace is dropped;
 *  an empty file yields no chunks. Exported for tests. */
export function chunkFile(text, path = '', cfg = {}) {
  const maxChars = clampNum(cfg.chunkMaxChars, DEFAULT_CHUNK_MAX_CHARS, 200, 20_000);
  const maxLines = clampNum(cfg.chunkMaxLines, DEFAULT_CHUNK_MAX_LINES, 5, 400);
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed === '') return [];
  const lines = trimmed.split('\n');
  const isMd = /\.(md|markdown|mdx)$/i.test(path);
  const chunks = [];
  let start = 0; // 0-based first line of the current chunk
  while (start < lines.length) {
    let end = start;    // exclusive 0-based upper bound as we grow the window
    let chars = 0;
    let lastBlank = -1; // last blank-line index inside the window — a preferred split point
    while (end < lines.length) {
      const add = lines[end].length + 1;
      if (end > start && (chars + add > maxChars || (end - start) >= maxLines)) break;
      chars += add;
      if (end > start && lines[end].trim() === '') lastBlank = end;
      end++;
    }
    // Prefer to break the chunk at a blank line, but only if that still leaves a substantial chunk.
    let breakAt = end;
    if (end < lines.length && lastBlank > start + Math.floor(maxLines / 3)) breakAt = lastBlank;
    const body = lines.slice(start, breakAt).join('\n');
    // Push every chunk (never skip) so ranges stay perfectly contiguous. startLine/endLine are 1-based
    // inclusive: slice [start, breakAt) → lines start+1 .. breakAt.
    chunks.push({ startLine: start + 1, endLine: breakAt, symbol: enclosingSymbol(lines, start, isMd), body });
    start = breakAt > start ? breakAt : start + 1;
  }
  return chunks;
}

/** Decide which repo-relative paths to (re)index and which to prune, from the current disk scan vs the
 *  stored `files` rows. A path is re-indexed when: `opts.full` (an explicit from-scratch rebuild), the
 *  path is new, its content hash differs from the stored one (an edit — a mere mtime touch with identical
 *  content is NOT re-embedded because the hash matches), or it is in `opts.stalePaths` (its stored chunks
 *  were embedded under a DIFFERENT model/width than the current one, so they must be rebuilt). Passing the
 *  stale set PER-PATH — instead of a blanket "rebuild everything" flag — is what lets a budget-capped model
 *  switch CONVERGE: each pass converts a fresh batch, those paths drop out of the stale set next pass, and
 *  the remaining `pending` strictly shrinks toward zero. A stored path no longer on disk is pruned. Pure. */
export function planIncremental(disk, dbFiles, opts = {}) {
  const full = !!opts.full;
  const stalePaths = opts.stalePaths instanceof Set ? opts.stalePaths : new Set(opts.stalePaths ?? []);
  const dbMap = new Map(dbFiles.map((f) => [f.path, f]));
  const diskPaths = new Set(disk.map((f) => f.path));
  const toIndex = [];
  for (const f of disk) {
    const prev = dbMap.get(f.path);
    if (full || !prev || prev.file_hash !== f.hash || stalePaths.has(f.path)) toIndex.push(f.path);
  }
  const toPrune = dbFiles.filter((f) => !diskPaths.has(f.path)).map((f) => f.path);
  return { toIndex, toPrune };
}

// ── config + glob matching ───────────────────────────────────────────────────────────────────────────

function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Compile a glob (`**`, `*`, `?`) to a RegExp anchored on the full repo-relative POSIX path. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function readConfig(raw) {
  const bool = (v, def) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : def);
  const include = splitList(raw.includeGlobs);
  const exclude = splitList(raw.excludeGlobs);
  return {
    includeGlobs: include.length ? include : DEFAULT_INCLUDE,
    excludeGlobs: exclude.length ? exclude : DEFAULT_EXCLUDE,
    maxFileBytes: clampNum(raw.maxFileBytes, 300_000, 1_000, 5_000_000),
    chunkMaxChars: clampNum(raw.chunkMaxChars, DEFAULT_CHUNK_MAX_CHARS, 200, 20_000),
    chunkMaxLines: DEFAULT_CHUNK_MAX_LINES,
    topK: clampNum(raw.topK, DEFAULT_TOP_K, 1, 50),
    relevanceFloor: clampNum(raw.relevanceFloor, DEFAULT_RELEVANCE_FLOOR, 0, 1),
    autoReindex: bool(raw.autoReindex, true),
    reindexEmbedBudget: clampNum(raw.reindexEmbedBudget, DEFAULT_EMBED_BUDGET, 1, 5_000),
  };
}

function makeMatchers(cfg) {
  const includeRes = cfg.includeGlobs.map(globToRegExp);
  const excludeBare = new Set(cfg.excludeGlobs.filter((g) => !/[*/]/.test(g))); // plain dir/file names
  const excludeRes = cfg.excludeGlobs.filter((g) => /[*/]/.test(g)).map(globToRegExp);
  return {
    includeFile: (rel) => includeRes.some((re) => re.test(rel)),
    excludeFile: (rel, name) => excludeBare.has(name) || excludeRes.some((re) => re.test(rel)),
    skipDir: (name, rel) => excludeBare.has(name) || excludeRes.some((re) => re.test(rel) || re.test(`${rel}/`)),
  };
}

function looksBinaryOrMinified(text) {
  if (text.includes('\u0000')) return true;
  let max = 0, cur = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { if (cur > max) max = cur; cur = 0; } else cur++;
  }
  if (cur > max) max = cur;
  return max > MINIFIED_MAX_LINE;
}

/** Walk one repo, returning `{ path (repo-relative POSIX), abs, mtimeMs, size, hash, body }`. Read-avoidance:
 *  a file whose (mtime,size) matches its stored row is NOT read (its stored hash is trusted, body=null);
 *  changed/new files are read once (body cached for chunking). Skips excluded dirs, non-included files,
 *  over-large files and binary/minified files. */
function collectFiles(repoAbs, cfg, dbFilesMap) {
  const m = makeMatchers(cfg);
  const out = [];
  const walk = (dirAbs, relPrefix) => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) break;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const abs = join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        if (!m.skipDir(ent.name, rel)) walk(abs, rel);
      } else if (ent.isFile()) {
        if (!m.includeFile(rel) || m.excludeFile(rel, ent.name)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size > cfg.maxFileBytes) continue;
        const mtimeMs = Math.floor(st.mtimeMs);
        const prev = dbFilesMap.get(rel);
        if (prev && prev.mtime_ms === mtimeMs && prev.size === st.size) {
          out.push({ path: rel, abs, mtimeMs, size: st.size, hash: prev.file_hash, body: null });
          continue;
        }
        let text;
        try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
        if (looksBinaryOrMinified(text)) continue;
        out.push({ path: rel, abs, mtimeMs, size: st.size, hash: hashText(text), body: text });
      }
    }
  };
  walk(repoAbs, '');
  return out;
}

// ── storage (plugin-owned SQLite in ctx.dataDir()) ───────────────────────────────────────────────────

function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol TEXT,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      UNIQUE(repo, path, start_line)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repo);
    CREATE TABLE IF NOT EXISTS files (
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (repo, path)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
const nowIso = () => new Date().toISOString();

function realAbs(p) {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}

// ── indexing ─────────────────────────────────────────────────────────────────────────────────────────

/** Reindex one repo: plan the incremental change set, prune vanished files, then re-chunk + re-embed the
 *  changed/new/stale files (bounded by `budget` chunks per pass). Returns a stats object; on a provider
 *  error it returns `{ error }` with whatever was done so far. Never throws. */
async function reindexRepo(ctx, db, repoAbs, opts) {
  const desc = ctx.embeddings.descriptor();
  if (!desc) return { error: 'embeddings not configured' };
  const cfg = opts.cfg;
  const dbFileRows = db.prepare('SELECT path, mtime_ms, size, file_hash FROM files WHERE repo = ?').all(repoAbs);
  const dbFilesMap = new Map(dbFileRows.map((r) => [r.path, r]));
  const disk = collectFiles(repoAbs, cfg, dbFilesMap);
  // Per-file model/dimension staleness: the exact paths whose stored chunks were embedded under a
  // different model (or width, when the provider pins one). Re-embedding ONLY these — not the whole repo
  // on every pass — is what makes a budget-capped model switch converge (see planIncremental): each pass
  // converts a fresh batch, so `pending` strictly shrinks instead of re-embedding the same leading files.
  const staleRows = desc.dimensions != null
    ? db.prepare('SELECT DISTINCT path FROM chunks WHERE repo = ? AND (model != ? OR dimensions != ?)').all(repoAbs, desc.model, desc.dimensions)
    : db.prepare('SELECT DISTINCT path FROM chunks WHERE repo = ? AND model != ?').all(repoAbs, desc.model);
  const stalePaths = new Set(staleRows.map((r) => r.path));
  const plan = planIncremental(disk, dbFileRows, { full: opts.full, stalePaths });

  const delChunks = db.prepare('DELETE FROM chunks WHERE repo = ? AND path = ?');
  const delFile = db.prepare('DELETE FROM files WHERE repo = ? AND path = ?');
  const insChunk = db.prepare(
    `INSERT INTO chunks (repo, path, start_line, end_line, symbol, body, content_hash, model, dimensions, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upFile = db.prepare('INSERT OR REPLACE INTO files (repo, path, mtime_ms, size, file_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)');

  // Prune vanished paths first (cheap — no embedding).
  db.transaction((paths) => { for (const p of paths) { delChunks.run(repoAbs, p); delFile.run(repoAbs, p); } })(plan.toPrune);

  const diskMap = new Map(disk.map((e) => [e.path, e]));
  let chunksEmbedded = 0;
  let filesChanged = 0;
  let pending = 0;
  for (const p of plan.toIndex) {
    if (chunksEmbedded >= opts.budget) { pending++; continue; } // budget spent → leave for the next pass
    const entry = diskMap.get(p);
    if (!entry) continue;
    let text = entry.body;
    if (text == null) { try { text = readFileSync(entry.abs, 'utf-8'); } catch { continue; } }
    const chunks = chunkFile(text, p, cfg);
    if (chunks.length === 0) {
      // Empty file: drop any stale chunks and record the (now empty) files row so it isn't re-scanned.
      db.transaction(() => { delChunks.run(repoAbs, p); upFile.run(repoAbs, p, entry.mtimeMs, entry.size, entry.hash, nowIso()); })();
      filesChanged++;
      continue;
    }
    let vectors;
    try { vectors = await ctx.embeddings.embedBatch(chunks.map((c) => c.body)); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e), filesScanned: disk.length, filesChanged, chunksEmbedded, pruned: plan.toPrune.length }; }
    db.transaction(() => {
      delChunks.run(repoAbs, p);
      chunks.forEach((c, i) => {
        const v = vectors[i];
        insChunk.run(repoAbs, p, c.startLine, c.endLine, c.symbol, c.body, hashText(c.body), desc.model, v.length, packVector(v));
      });
      upFile.run(repoAbs, p, entry.mtimeMs, entry.size, entry.hash, nowIso());
    })();
    chunksEmbedded += chunks.length;
    filesChanged++;
  }
  return { filesScanned: disk.length, filesChanged, chunksEmbedded, pruned: plan.toPrune.length, pending };
}

// ── repo scoping ─────────────────────────────────────────────────────────────────────────────────────

/** The concrete repos to (auto)index for the current session. An explicit `repoArg` is asserted against
 *  the session's policy (throws when out of scope). Otherwise: the session's allowed roots, or — for an
 *  admin all-access session with no roots — the turn's default working directory (the current project). */
function indexTargets(ctx, repoArg) {
  if (repoArg) return [realAbs(ctx.assertPathAllowed(repoArg))];
  const roots = ctx.allowedRoots();
  if (roots.length) return roots.map(realAbs);
  const cwd = typeof ctx.defaultCwd === 'function' ? ctx.defaultCwd() : undefined;
  return cwd ? [realAbs(cwd)] : [];
}

/** Which repos' chunks the current session may SEE. Returns null for an admin all-access session with no
 *  explicit repo (every indexed repo is visible); otherwise the concrete allowed repo list (possibly []). */
function searchScope(ctx, repoArg) {
  if (repoArg) return [realAbs(ctx.assertPathAllowed(repoArg))];
  const roots = ctx.allowedRoots();
  if (roots.length) return roots.map(realAbs);
  return ctx.isAdminSession() ? null : [];
}

/** Stream the SCORING columns (id/repo/path/lines/symbol/vector — deliberately NOT `body`) for the
 *  in-scope chunks that match the CURRENT embedding model AND width, filtered in SQL so a query never
 *  materializes the whole table into JS and never cosines a foreign-model or wrong-width vector. Returns a
 *  better-sqlite3 row cursor (`.iterate`). `scope === null` = admin all-access (every repo). Callers guard
 *  the empty-scope case before calling. */
function chunkCursor(db, scope, model, dims) {
  const cols = 'id, repo, path, start_line, end_line, symbol, vector';
  if (scope === null) {
    return db.prepare(`SELECT ${cols} FROM chunks WHERE model = ? AND dimensions = ?`).iterate(model, dims);
  }
  const placeholders = scope.map(() => '?').join(',');
  return db.prepare(`SELECT ${cols} FROM chunks WHERE repo IN (${placeholders}) AND model = ? AND dimensions = ?`).iterate(...scope, model, dims);
}

/** Insert `item` into `arr` (kept sorted by DESCENDING score), keeping at most the top `k`. O(k) per
 *  insert with O(k) memory, so ranking an N-chunk index is O(N·k) time / O(k) space — no full-table
 *  materialization and no sort of every above-floor row. */
function pushTopK(arr, item, k) {
  if (arr.length >= k && item.score <= arr[arr.length - 1].score) return;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].score >= item.score) lo = mid + 1; else hi = mid; }
  arr.splice(lo, 0, item);
  if (arr.length > k) arr.pop();
}

// ── plugin registration ──────────────────────────────────────────────────────────────────────────────

export function register(ctx) {
  const cfg = readConfig(ctx.config);
  let db = null;
  const getDb = () => {
    if (!db) db = openDb(join(ctx.dataDir(), 'index.db'));
    return db;
  };

  // Lazily run ONE bounded incremental pass per stale-by-time repo. ADMIN-GATED at the call site (it writes
  // shared state + spends the embedding provider — exactly what codebase_reindex refuses to non-admins).
  // The 5-minute debounce ALWAYS applies — even to a repo that indexes to zero chunks (a failing provider,
  // an all-excluded repo) — so a persistently-empty repo can't re-walk + re-embed on every search. Never
  // throws (best-effort; a failed pass must not break the search).
  const maybeAutoReindex = async (database, repos) => {
    if (!cfg.autoReindex || !ctx.embeddings.isConfigured()) return;
    const now = Date.now();
    for (const repo of repos) {
      const last = Number(getMeta(database, `reindex:${repo}`) ?? 0);
      if (now - last < AUTO_REINDEX_DEBOUNCE_MS) continue;
      try { await reindexRepo(ctx, database, repo, { cfg, budget: cfg.reindexEmbedBudget, full: false }); }
      catch { /* auto-reindex is best-effort — never break a search */ }
      setMeta(database, `reindex:${repo}`, String(now));
    }
  };

  ctx.registerTool(defineTool({
    name: 'codebase_search', label: 'Codebase search',
    description: [
      'Semantic (meaning-based) search over the accessible repositories: find the code/docs most relevant',
      'to a natural-language query, ranked by embedding similarity — not literal text matching.',
      'Use it to locate where a concept/behavior lives ("where do we verify a JWT", "the retry backoff logic")',
      'when you do not know the exact identifier. For exact strings/regex/symbols prefer search_files.',
      'Output is the top matches as `path:startLine-endLine [symbol] (score)` with a short snippet; results',
      'below the relevance floor are dropped. Requires an embedding model configured in Settings → Memory.',
    ].join(' '),
    parameters: Type.Object({
      query: Type.String({ description: 'Natural-language description of what you are looking for' }),
      k: Type.Optional(Type.Number({ description: 'Max results to return (default from config, capped at 50)' })),
      repo: Type.Optional(Type.String({ description: 'Restrict to this repository root (must be accessible)' })),
      pathGlob: Type.Optional(Type.String({ description: 'Restrict to paths matching this glob, e.g. "src/**/*.ts"' })),
    }),
    execute: async (_id, p) => {
      try {
        if (!ctx.embeddings.isConfigured()) {
          return fail('codebase_search', new Error('semantic code search needs an embedding model — set one in Settings → Memory (the same model memory uses). For literal text search use search_files.'));
        }
        const query = String(p.query ?? '').trim();
        if (!query) return fail('codebase_search', new Error('query is required'));
        const scope = searchScope(ctx, p.repo);
        if (Array.isArray(scope) && scope.length === 0) return ok('codebase_search', 'No accessible repositories to search.', { matches: 0 });
        const database = getDb();
        const desc = ctx.embeddings.descriptor();

        // Auto-reindex is ADMIN-ONLY (same gate as codebase_reindex: it writes shared state + spends the
        // embedding provider). Fire-and-forget so the search answer NEVER waits on a full walk+embed pass —
        // freshly embedded chunks surface on the NEXT search; the 5-minute debounce guards re-entry.
        let kickedReindex = false;
        if (cfg.autoReindex && ctx.isAdminSession()) {
          kickedReindex = true;
          void maybeAutoReindex(database, indexTargets(ctx, p.repo)).catch(() => {});
        }

        const qv = await ctx.embeddings.embed(query);
        const glob = p.pathGlob ? globToRegExp(String(p.pathGlob)) : null;
        const k = clampNum(p.k, cfg.topK, 1, 50);
        const top = [];
        let scanned = 0;
        // Stream candidates (current-model, matching-width, in-scope — all filtered in SQL) and keep only a
        // running top-k, so a query never loads the whole chunks table (bodies + vectors) into memory.
        for (const row of chunkCursor(database, scope, desc?.model ?? '', qv.length)) {
          scanned++;
          if (glob && !glob.test(row.path)) continue;
          const score = cosine(qv, unpackVector(row.vector));
          if (score < cfg.relevanceFloor) continue;
          // Defense-in-depth: re-assert the absolute path is inside the session's repos (symlink-safe).
          try { ctx.assertPathAllowed(join(row.repo, row.path)); } catch { continue; }
          pushTopK(top, { id: row.id, path: row.path, start_line: row.start_line, end_line: row.end_line, symbol: row.symbol, score }, k);
        }

        if (scanned === 0) {
          // No vectors under the current model for this session's repos. An admin's search already kicked a
          // background (re)index; a non-admin can't build the index (it's admin-gated), so say so plainly.
          return kickedReindex
            ? ok('codebase_search', 'The semantic index has no chunks yet for the current embedding model. A background refresh is running — try again shortly. For literal text search use search_files.', { matches: 0 })
            : fail('codebase_search', new Error('the semantic code index for your repositories is empty — ask an operator (admin) to run codebase_reindex to build it, or use search_files for literal text search'));
        }
        if (top.length === 0) return ok('codebase_search', `No matches above the relevance floor (${cfg.relevanceFloor}) for: ${query}`, { matches: 0 });

        // Fetch bodies only for the handful of winners (k ≤ 50), keyed by id.
        const bodyOf = database.prepare('SELECT body FROM chunks WHERE id = ?');
        const text = top.map(({ id, path: rpath, start_line, end_line, symbol, score }) => {
          const body = bodyOf.get(id)?.body ?? '';
          const head = `${rpath}:${start_line}-${end_line}${symbol ? `  [${symbol}]` : ''}  (${score.toFixed(3)})`;
          const snippet = body.split('\n').slice(0, SNIPPET_MAX_LINES).join('\n').slice(0, SNIPPET_MAX_CHARS);
          return `${head}\n${snippet.split('\n').map((l) => `    ${l}`).join('\n')}`;
        }).join('\n\n');
        return ok('codebase_search', text, { matches: top.length });
      } catch (e) { return fail('codebase_search', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'codebase_reindex', label: 'Codebase reindex',
    description: [
      'Rebuild or refresh the semantic code index for the accessible repositories (incremental by default:',
      'only changed/new files are re-embedded; pass full to rebuild from scratch). Admin sessions only —',
      'it writes shared state and spends the embedding provider. Returns how many files/chunks were indexed.',
    ].join(' '),
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: 'Only reindex this repository root (must be accessible)' })),
      full: Type.Optional(Type.Boolean({ description: 'Rebuild every file instead of only the changed ones' })),
    }),
    execute: async (_id, p) => {
      try {
        if (!ctx.isAdminSession()) return fail('codebase_reindex', new Error('codebase_reindex requires an admin session'));
        if (!ctx.embeddings.isConfigured()) {
          return fail('codebase_reindex', new Error('no embedding model configured — set one in Settings → Memory'));
        }
        const targets = indexTargets(ctx, p.repo);
        if (targets.length === 0) return fail('codebase_reindex', new Error('no repository to index'));
        const database = getDb();
        const results = [];
        for (const repo of targets) {
          const r = await reindexRepo(ctx, database, repo, { cfg, budget: cfg.reindexEmbedBudget, full: !!p.full });
          setMeta(database, `reindex:${repo}`, String(Date.now()));
          results.push({ repo, ...r });
        }
        const anyError = results.find((r) => r.error);
        const lines = results.map((r) => r.error
          ? `${r.repo}: error — ${r.error} (indexed ${r.chunksEmbedded ?? 0} chunks before failing)`
          : `${r.repo}: ${r.filesChanged} file(s) changed, ${r.chunksEmbedded} chunk(s) embedded, ${r.pruned} pruned${r.pending ? `, ${r.pending} file(s) pending (budget)` : ''}`);
        const totals = results.reduce((a, r) => ({
          filesChanged: a.filesChanged + (r.filesChanged ?? 0),
          chunksEmbedded: a.chunksEmbedded + (r.chunksEmbedded ?? 0),
          pruned: a.pruned + (r.pruned ?? 0),
          pending: a.pending + (r.pending ?? 0),
        }), { filesChanged: 0, chunksEmbedded: 0, pruned: 0, pending: 0 });
        return anyError
          ? fail('codebase_reindex', new Error(lines.join('\n')), totals)
          : ok('codebase_reindex', lines.join('\n'), totals);
      } catch (e) { return fail('codebase_reindex', e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'codebase_status', label: 'Codebase status',
    description: [
      'Report the semantic index state per accessible repository: indexed chunk/file counts, when it was',
      'last indexed, the embedding model/dimensions the vectors were built with, and whether any are stale',
      "against the currently configured model. Use it to check coverage before relying on codebase_search.",
    ].join(' '),
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: 'Only report this repository root (must be accessible)' })),
    }),
    execute: async (_id, p) => {
      try {
        const database = getDb();
        const scope = searchScope(ctx, p.repo);
        const desc = ctx.embeddings.descriptor();
        const repoFilter = scope === null
          ? database.prepare('SELECT DISTINCT repo FROM files').all().map((r) => r.repo)
          : scope;
        if (repoFilter.length === 0) return ok('codebase_status', 'No repositories indexed yet. Run codebase_reindex.', { repos: 0, configured: !!desc });
        const rows = repoFilter.map((repo) => {
          const chunks = database.prepare('SELECT COUNT(*) AS n FROM chunks WHERE repo = ?').get(repo).n;
          const files = database.prepare('SELECT COUNT(*) AS n FROM files WHERE repo = ?').get(repo).n;
          const last = database.prepare('SELECT MAX(indexed_at) AS t FROM files WHERE repo = ?').get(repo).t;
          const models = database.prepare('SELECT DISTINCT model, dimensions FROM chunks WHERE repo = ?').all(repo);
          const stale = desc ? models.some((m) => m.model !== desc.model || (desc.dimensions != null && m.dimensions !== desc.dimensions)) : false;
          const built = models.map((m) => `${m.model}/${m.dimensions}`).join(', ') || '(none)';
          return `${repo}\n    chunks: ${chunks}, files: ${files}, lastIndexed: ${last ?? 'never'}, builtWith: ${built}${stale ? '  [STALE — reindex]' : ''}`;
        });
        const header = desc
          ? `Embedding model: ${desc.model} (dims ${desc.dimensions ?? 'auto'})`
          : 'Embedding model: NOT CONFIGURED (set one in Settings → Memory)';
        return ok('codebase_status', `${header}\n\n${rows.join('\n')}`, { repos: repoFilter.length, configured: !!desc });
      } catch (e) { return fail('codebase_status', e); }
    },
  }));

  ctx.logger.info('registered codebase_search, codebase_reindex, codebase_status');
}
