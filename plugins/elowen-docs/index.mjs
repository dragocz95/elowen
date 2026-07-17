// ElowenDocs — semantic search over Elowen's OWN shipped user manual (docs/site/*.md).
//
// Deliberately NOT a second `codebase` plugin, and the difference is the corpus, not the taste. The
// codebase plugin indexes the CALLER's repositories: arbitrary, mutable, per-user, path-gated — which is
// why it carries incremental planning, mtime tracking, pruning, globs, embed budgets and per-repo scoping.
// This corpus is the opposite in every one of those respects: fixed at install, identical for every user,
// read-only, public, and changed only by upgrading Elowen. So the whole lifecycle collapses to one
// fingerprint — if the docs or the embedding model differ from what is indexed, rebuild the lot (a few
// hundred chunks, seconds); otherwise score and rank. No incremental machinery, because nothing is
// incremental.
//
// Shared with codebase: the vector pipeline (ctx.embeddings — the operator's ONE Settings → Memory
// model). Inlined: the pure math + BLOB packing, which the codebase plugin itself inlines rather than
// shares, on the stated grounds that pure helpers are not the embedding INFRA.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const TOOL = 'ElowenDocs';
const DEFAULT_K = 6;
const MAX_K = 20;
const EMBED_BATCH = 64;        // bounded against the embedding service's 30s HTTP timeout
const MAX_CHARS = 1500;        // a heading section longer than this is split on a paragraph break

// ── tool result idiom (never throw — return the error as text, like the codebase/files plugins) ──────
const ok = (text, details = {}) => ({
  content: [{ type: 'text', text }],
  details: { ok: true, tool: TOOL, ...details },
});
const fail = (e, details = {}) => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  details: { ok: false, tool: TOOL, error: { message: e instanceof Error ? e.message : String(e) }, ...details },
});

// ── pure helpers (exported for unit tests) ───────────────────────────────────────────────────────────

/** sha256 hex of a UTF-8 string. */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Pack a Float32 vector into a raw little-endian BLOB (mirrors codebase/memoryStore). */
export function packVector(vec) {
  if (Buffer.isBuffer(vec)) return vec;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a little-endian BLOB back to a Float32Array (mirrors codebase/memoryStore). */
export function unpackVector(buf) {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Cosine similarity — 0 on a length mismatch or a zero-norm input (mirrors codebase/memoryService). */
export function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Strip YAML frontmatter and return the body plus whatever `title:` it declared. */
export function stripFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text, title: '' };
  const title = /^title:\s*(.+)$/m.exec(m[1] ?? '');
  return { body: text.slice(m[0].length), title: (title?.[1] ?? '').trim().replace(/^["']|["']$/g, '') };
}

/** Split one doc into retrievable sections, one per heading.
 *
 *  The unit is a HEADING SECTION, not codebase's fixed line window — that is the whole reason this is not
 *  the same chunker. A question about Elowen is answered by a section of the manual ("Autonomy levels"),
 *  and the heading path is both the strongest signal for matching it and the answer to "where is this".
 *  A section longer than MAX_CHARS is split on a paragraph break so one sprawling section cannot dominate
 *  a chunk; the split parts keep the same heading path. */
export function chunkMarkdown(text, path) {
  const { body, title } = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const docTitle = title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path;

  const sections = [];
  // Indexed BY HEADING LEVEL, and deliberately sparse: `trail[level - 1]` is the ancestor at that level,
  // so a document that skips one (h1 → h3) leaves a hole. Compacting the array would put the h3 at index
  // 1, and the NEXT h3 would then slice at 2 and keep its own sibling as its parent.
  let trail = [];
  let current = null;
  const headingOf = () => trail.filter((t) => t != null).join(' › ');   // filter skips holes; join would not
  const push = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (content) sections.push({ heading: current.heading, content });
    current = null;
  };
  let inFence = false;
  for (const line of lines) {
    // A fence flips the meaning of '#': the manual's install page opens ```bash blocks whose comments
    // ("# Linux (Debian/Ubuntu)") would otherwise parse as level-1 headings, reset the trail, and
    // re-parent every following section under a shell comment — in the vector as well as the label.
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      (current ??= { heading: headingOf() || docTitle, lines: [] }).lines.push(line);
      continue;
    }
    const h = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (!h) { (current ??= { heading: headingOf() || docTitle, lines: [] }).lines.push(line); continue; }
    push();
    const level = h[1].length;
    trail = trail.slice(0, level - 1);   // slice preserves holes
    trail[level - 1] = h[2].trim();
    current = { heading: headingOf(), lines: [] };
  }
  push();

  // A heading with nothing under it is a container for the ones below, not a retrievable answer.
  return sections.flatMap((s) => splitLong(s, docTitle));
}

/** Break an over-long section on the last paragraph gap that still leaves a substantial head.
 *  No line numbers: the locator this plugin publishes is `path § heading`, and a citation nobody prints
 *  is arithmetic nobody validates. */
function splitLong(section, docTitle) {
  const out = [];
  let rest = section.content;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    const gap = window.lastIndexOf('\n\n');
    const cut = gap > MAX_CHARS / 3 ? gap : MAX_CHARS;
    out.push({ heading: section.heading, docTitle, body: rest.slice(0, cut).trim() });
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push({ heading: section.heading, docTitle, body: rest.trim() });
  return out;
}

/** The identity of an indexed corpus: its content, plus the embedding model that turned it into vectors.
 *  One value answers both "did the docs change (an upgrade)" and "did the model change" — the only two
 *  things that can invalidate this index, since nothing else ever writes to the corpus. */
export function corpusFingerprint(files, model, dimensions) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path, 'utf8');
    h.update(hashText(f.text), 'utf8');
  }
  h.update(`|${model}|${dimensions ?? ''}`, 'utf8');
  return h.digest('hex');
}

/** Rank chunks by literal word overlap — the fallback when no embedding model is configured.
 *
 *  Not a rival implementation of the search: a fresh install has no embedding model, and "how do I set
 *  this up?" is exactly the question this tool exists to answer and exactly the moment it cannot embed.
 *  A worse answer beats an error telling the user to go configure the thing they are asking about.
 *  Headings count for more than prose because they are what the query usually names. */
export function keywordRank(chunks, query, k) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  if (terms.length === 0) return [];
  return chunks
    .map((c) => {
      const heading = `${c.docTitle} ${c.heading}`.toLowerCase();
      const body = c.body.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (heading.includes(t)) score += 3;
        if (body.includes(t)) score += 1;
      }
      return { ...c, score: score / (terms.length * 4) };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ── corpus ───────────────────────────────────────────────────────────────────────────────────────────

/** Find the shipped manual. Walking up beats hardcoding a depth because there are two real layouts: this
 *  checkout (`<repo>/plugins/elowen-docs`) and an npm install (`<pkg>/dist/plugins/elowen-docs`, since the
 *  build copies plugins under dist/). The marker is both files, so a stray package.json cannot win. */
export function resolveDocsRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const site = join(dir, 'docs', 'site');
    if (existsSync(join(dir, 'package.json')) && existsSync(site)) return site;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Read the manual: the numbered pages only. Not a glob and not a directory walk — the corpus is a known,
 *  fixed list, and an exact shape is what keeps an unrelated file (an internal note, a draft) from ever
 *  being indexed and quoted back to a user as documentation. */
export function readCorpus(root) {
  return readdirSync(root)
    .filter((f) => /^\d{2}-[a-z0-9-]+\.md$/.test(f))
    .sort()
    .map((f) => ({ path: `docs/site/${f}`, text: readFileSync(join(root, f), 'utf8') }));
}

// ── storage (plugin-owned SQLite in ctx.dataDir()) ───────────────────────────────────────────────────

function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      doc_title TEXT NOT NULL,
      heading TEXT NOT NULL,
      body TEXT NOT NULL,
      vector BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────

/** Path + heading path, never a URL: the site's published link scheme is not defined in this repo, so a
 *  constructed URL would be a guess. A repo-relative path is verifiable and already answers "where". */
function renderMatches(matches, note) {
  const rows = matches.map((m) => {
    const where = `${m.path}${m.heading ? ` § ${m.heading}` : ''}`;
    return `${where}  (${m.score.toFixed(3)})\n${m.body.split('\n').map((l) => `    ${l}`).join('\n')}`;
  });
  return `${note ? `${note}\n\n` : ''}${rows.join('\n\n')}`;
}

// ── plugin ───────────────────────────────────────────────────────────────────────────────────────────

export function register(ctx) {
  // Everything stays lazy: register() runs for every bundled plugin at load, including in tests that
  // supply no data directory and no embedder.
  let db = null;
  let building = null;
  const getDb = () => (db ??= openDb(join(ctx.dataDir(), 'index.db')));

  /** Bring the index in line with the corpus + the current embedding model, rebuilding wholesale when the
   *  fingerprint moved. Single-flighted: concurrent first calls must embed once, not once each. */
  const ensureIndex = async (database, files, desc) => {
    const want = corpusFingerprint(files, desc.model, desc.dimensions);
    if (getMeta(database, 'fingerprint') === want) return;
    if (building) return building;
    building = (async () => {
      const chunks = files.flatMap((f) => chunkMarkdown(f.text, f.path).map((c) => ({ ...c, path: f.path })));
      const vectors = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        vectors.push(...await ctx.embeddings.embedBatch(chunks.slice(i, i + EMBED_BATCH).map((c) => `${c.docTitle} › ${c.heading}\n${c.body}`)));
      }
      // One transaction: a half-written index that still carried the new fingerprint would be believed.
      database.transaction(() => {
        database.prepare('DELETE FROM chunks').run();
        const ins = database.prepare('INSERT INTO chunks (path, doc_title, heading, body, vector) VALUES (?, ?, ?, ?, ?)');
        chunks.forEach((c, i) => ins.run(c.path, c.docTitle, c.heading, c.body, packVector(vectors[i])));
        setMeta(database, 'fingerprint', want);
        setMeta(database, 'indexed_at', new Date().toISOString());
      })();
      ctx.logger.info(`elowen-docs: indexed ${chunks.length} sections from ${files.length} pages (${desc.model})`);
    })().finally(() => { building = null; });
    return building;
  };

  ctx.registerTool(defineTool({
    name: TOOL,
    label: 'Elowen docs',
    description: 'Search Elowen\'s own user manual by meaning and return the most relevant sections, each with the page and heading it came from. Ask it what Elowen can do, where a feature lives, or how a setting works — before guessing, and before changing configuration. For the user\'s OWN code use CodebaseSearch instead.',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural-language question about Elowen, e.g. "how do I limit what an agent may do on its own?"' }),
      k: Type.Optional(Type.Number({ description: `Max sections to return (default ${DEFAULT_K}, capped at ${MAX_K})` })),
    }),
    execute: async (_id, p) => {
      try {
        const query = String(p.query ?? '').trim();
        if (!query) return fail(new Error('query is required'));
        const k = Math.min(MAX_K, Math.max(1, Math.floor(Number(p.k) || DEFAULT_K)));

        const root = resolveDocsRoot();
        if (!root) return fail(new Error('the shipped documentation was not found next to this installation'));
        const files = readCorpus(root);
        if (files.length === 0) return ok('No documentation pages are installed.', { matches: 0 });

        // No embedding model: rank by words instead of meaning and SAY SO, rather than refusing. A fresh
        // install has no model configured, which is exactly when someone asks how to configure one.
        if (!ctx.embeddings.isConfigured()) {
          const chunks = files.flatMap((f) => chunkMarkdown(f.text, f.path).map((c) => ({ ...c, path: f.path })));
          const hits = keywordRank(chunks, query, k);
          if (hits.length === 0) return ok(`No section matched "${query}" by keyword.\n\nThis is a keyword search: semantic search needs an embedding model (Settings → Memory).`, { matches: 0, mode: 'keyword' });
          return ok(renderMatches(hits, 'Keyword match — semantic search needs an embedding model (Settings → Memory).'), { matches: hits.length, mode: 'keyword' });
        }

        const desc = ctx.embeddings.descriptor();
        const database = getDb();
        await ensureIndex(database, files, desc);

        // Rank and return the best k — deliberately NO minimum-score cutoff, unlike the codebase plugin.
        // Cosine here is not comparable across queries: measured on the shipped manual, "how do I install
        // Elowen?" puts HALF the corpus above 0.3 while "co je to mise?" — a perfectly good question —
        // tops out at 0.148. One threshold either floods or returns nothing, depending on the question's
        // language and phrasing, and the right number would differ per embedding model anyway. The order
        // is what is reliable, so rank, cap at k, and publish the score for the reader to weigh.
        const qv = await ctx.embeddings.embed(query);
        const scored = [];
        for (const row of database.prepare('SELECT path, doc_title AS docTitle, heading, body, vector FROM chunks').iterate()) {
          scored.push({ ...row, score: cosine(qv, unpackVector(row.vector)) });
        }
        scored.sort((a, b) => b.score - a.score);
        const hits = scored.slice(0, k);
        if (hits.length === 0) return ok('No documentation is indexed.', { matches: 0, mode: 'semantic' });
        return ok(renderMatches(hits, 'Closest sections of the manual, best first. Scores are relative to this query only — do not read them as absolute confidence.'), { matches: hits.length, mode: 'semantic', model: desc.model, indexedAt: getMeta(database, 'indexed_at') });
      } catch (e) {
        return fail(e);
      }
    },
  }));

  ctx.logger.info(`elowen-docs registered (${TOOL})`);
}
