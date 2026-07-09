import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { EmbeddingConfig } from '../../src/embeddings/embeddingService.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginEntry = join(repoRoot, 'plugins/codebase/index.mjs');

const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy = (): Policy => ({ allowedProjectIds: 'all', allowedPaths: () => [] });

type ToolResult = { content: { text: string }[]; details: Record<string, unknown> };
const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>): Promise<ToolResult> => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<ToolResult> }).execute('t', params);
};

// A deterministic bag-of-words "embedder": each text maps to a fixed-width vector of vocab-word counts.
// Cosine over these vectors gives real, meaningful ranking (shared vocab → higher score) with zero network.
const VOCAB = ['cosine', 'similarity', 'vector', 'dot', 'product', 'background', 'job', 'embedding', 'queue', 'missing', 'memory', 'http', 'client', 'search', 'index'];
const fakeVec = (text: string): Float32Array => {
  const t = text.toLowerCase();
  return Float32Array.from(VOCAB.map((w) => (t.match(new RegExp(w, 'g'))?.length ?? 0)));
};
const fakeEmbedder = {
  embed: async (_cfg: EmbeddingConfig, text: string) => fakeVec(text),
  embedBatch: async (_cfg: EmbeddingConfig, texts: string[]) => texts.map(fakeVec),
};

// ── pure exports ─────────────────────────────────────────────────────────────────────────────────────
describe('codebase plugin — pure helpers', () => {
  const load = async () => (await import(pluginEntry)) as {
    chunkFile: (t: string, path?: string, cfg?: Record<string, unknown>) => { startLine: number; endLine: number; symbol: string | null; body: string }[];
    planIncremental: (disk: { path: string; hash: string }[], dbFiles: { path: string; file_hash: string }[], opts?: { full?: boolean; stalePaths?: Set<string> }) => { toIndex: string[]; toPrune: string[] };
    packVector: (v: Float32Array | Buffer) => Buffer;
    unpackVector: (b: Buffer) => Float32Array;
    cosine: (a: Float32Array, b: Float32Array) => number;
  };

  it('chunkFile: contiguous 1-based ranges covering the whole file, bounded by chunkMaxChars', async () => {
    const { chunkFile } = await load();
    const src = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i}; // some code content here`).join('\n');
    const chunks = chunkFile(src, 'src/a.ts', { chunkMaxChars: 200, chunkMaxLines: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    expect(chunks.at(-1)!.endLine).toBe(30);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(200);
  });

  it('chunkFile: extracts a TS function symbol and a Markdown heading', async () => {
    const { chunkFile } = await load();
    const ts = chunkFile('export function verifyToken(t) {\n  return check(t);\n}', 'auth.ts', {});
    expect(ts[0].symbol).toBe('verifyToken');
    const md = chunkFile('## Retry backoff\n\nWe wait before retrying.', 'docs/notes.md', {});
    expect(md[0].symbol).toBe('Retry backoff');
  });

  it('chunkFile: empty/whitespace file yields no chunks', async () => {
    const { chunkFile } = await load();
    expect(chunkFile('   \n\n  ', 'x.ts', {})).toEqual([]);
  });

  it('planIncremental: skips unchanged, re-indexes edited/new, prunes vanished', async () => {
    const { planIncremental } = await load();
    const disk = [{ path: 'a', hash: '1' }, { path: 'b', hash: '2new' }, { path: 'c', hash: '3' }];
    const dbFiles = [{ path: 'a', file_hash: '1' }, { path: 'b', file_hash: '2old' }, { path: 'd', file_hash: '4' }];
    const plan = planIncremental(disk, dbFiles, {});
    expect(plan.toIndex.sort()).toEqual(['b', 'c']); // b edited, c new; a unchanged
    expect(plan.toPrune).toEqual(['d']);             // d gone from disk
  });

  it('planIncremental: a model switch re-embeds only the not-yet-converted files (convergence, #4)', async () => {
    const { planIncremental } = await load();
    const disk = [{ path: 'a', hash: '1' }, { path: 'b', hash: '2' }];
    const dbFiles = [{ path: 'a', file_hash: '1' }, { path: 'b', file_hash: '2' }];
    // Both files still under the old model → both rebuilt this pass.
    expect(planIncremental(disk, dbFiles, { stalePaths: new Set(['a', 'b']) }).toIndex.sort()).toEqual(['a', 'b']);
    // 'a' was reconverted in an earlier pass and dropped out of the stale set → only 'b' remains. This is
    // the convergence guarantee: the leading file is NOT re-embedded every pass, so `pending` shrinks.
    expect(planIncremental(disk, dbFiles, { stalePaths: new Set(['b']) }).toIndex).toEqual(['b']);
    expect(planIncremental(disk, dbFiles, { full: true }).toIndex.sort()).toEqual(['a', 'b']); // full → all
    expect(planIncremental(disk, dbFiles, {}).toIndex).toEqual([]); // no staleness, unchanged → nothing
  });

  it('packVector/unpackVector: round-trips a Float32Array bit-exact', async () => {
    const { packVector, unpackVector } = await load();
    const v = Float32Array.from([0.125, -2.5, 3.1415927, 0, 1e-9, -1e9]);
    const round = unpackVector(packVector(v));
    expect(round.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) expect(round[i]).toBe(v[i]);
  });

  it('cosine: 1 for identical, 0 for orthogonal or length-mismatch', async () => {
    const { cosine } = await load();
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2, 3]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});

// ── integration: real better-sqlite3 index over a fixture repo, driven through loadPlugins ─────────────
describe('codebase plugin — index + search', () => {
  let reg: PluginRegistry;
  let repo1: string;
  let repo2: string;
  let dataRoot: string;
  let liveCfg: EmbeddingConfig;

  const loadReg = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log,
    dataRoot,
    embeddings: fakeEmbedder,
    embeddingConfig: () => liveCfg,
  });

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb-data-'));
    repo1 = mkdtempSync(join(tmpdir(), 'elowen-cb-r1-'));
    repo2 = mkdtempSync(join(tmpdir(), 'elowen-cb-r2-'));
    liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };

    mkdirSync(join(repo1, 'src'), { recursive: true });
    // A chunk rich in cosine/similarity/vector/dot/product vocabulary.
    writeFileSync(join(repo1, 'src', 'math.ts'),
      'export function cosineSimilarity(a, b) {\n  // cosine similarity of two vector inputs: dot product over norms\n  let dot = 0;\n  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];\n  return dot;\n}\n');
    // A chunk about the background embedding queue filling missing memory embeddings.
    writeFileSync(join(repo1, 'src', 'queue.ts'),
      'export class EmbeddingQueue {\n  // background job that fills in missing memory embedding vectors\n  drain() { return this.background(); }\n}\n');
    // A non-included file that must never be indexed.
    writeFileSync(join(repo1, 'notes.bin'), 'cosine cosine cosine');
    // repo2 has its own cosine content — used to prove scoping keeps it invisible to a repo1-only session.
    writeFileSync(join(repo2, 'other.ts'), 'export function cosineOther(a, b) { return dot(a, b); } // cosine similarity vector\n');

    reg = await loadReg();
  });

  it('declares exactly its three tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['codebase_reindex', 'codebase_search', 'codebase_status']);
  });

  it('reindex (admin) writes a real index.db with chunk rows carrying the configured model', async () => {
    const res = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: repo1 }), { workDir: repo1 });
    expect(res.details.ok).toBe(true);
    expect(res.details.chunksEmbedded as number).toBeGreaterThan(0);

    const db = new Database(join(dataRoot, 'codebase', 'index.db'), { readonly: true });
    const paths = db.prepare('SELECT DISTINCT path FROM chunks ORDER BY path').all().map((r: { path: string }) => r.path);
    expect(paths).toContain('src/math.ts');
    expect(paths).toContain('src/queue.ts');
    expect(paths).not.toContain('notes.bin'); // excluded by include-globs
    const models = db.prepare('SELECT DISTINCT model, dimensions FROM chunks').all() as { model: string; dimensions: number }[];
    expect(models).toEqual([{ model: 'fake-1', dimensions: VOCAB.length }]);
    db.close();
  });

  it('search ranks the semantically closest chunk first and drops sub-floor hits', async () => {
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_search', { query: 'cosine similarity of two vectors', k: 5 }));
    expect(res.details.ok).toBe(true);
    const text = res.content[0].text;
    // math.ts (cosine/similarity/vector/dot/product) beats queue.ts (background/job/embedding).
    expect(text.indexOf('src/math.ts')).toBeGreaterThanOrEqual(0);
    expect(text.split('\n')[0]).toContain('src/math.ts');
    // queue.ts shares no vocab with this query → score 0 < floor → filtered out entirely.
    expect(text).not.toContain('src/queue.ts');
  });

  it('a different query surfaces the background-embedding-queue chunk', async () => {
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_search', { query: 'background job that fills in missing memory embeddings' }));
    expect(res.content[0].text.split('\n')[0]).toContain('src/queue.ts');
  });

  it('a pathGlob narrows results to matching files', async () => {
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector', pathGlob: 'src/queue.ts' }));
    const text = res.content[0].text;
    expect(text).not.toContain('src/math.ts');
  });

  it('repo scoping: a repo1-only session never sees repo2 chunks', async () => {
    // Index repo2 as admin, then search as a repo1-scoped user — repo2 must stay invisible.
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: repo2 }), { workDir: repo2 });
    const scoped = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector dot product' }));
    expect(scoped.content[0].text).not.toContain('other.ts');
    // An admin (all-access, no roots) CAN see repo2's chunk.
    const admin = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector dot product' }), { workDir: repo1 });
    expect(admin.content[0].text).toContain('other.ts');
  });

  it('reindex is refused for a non-admin session', async () => {
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_reindex', {}));
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain('admin');
  });

  it('an incremental reindex re-embeds only edited files and prunes deleted ones', async () => {
    const edited = mkdtempSync(join(tmpdir(), 'elowen-cb-inc-'));
    writeFileSync(join(edited, 'keep.ts'), 'export function keep() { return 1; } // cosine vector\n');
    writeFileSync(join(edited, 'gone.ts'), 'export function gone() { return 2; } // dot product\n');
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: edited }), { workDir: edited });

    // Edit one file (new content), delete the other.
    writeFileSync(join(edited, 'keep.ts'), 'export function keep() { return 42; } // cosine similarity vector product changed\n');
    rmSync(join(edited, 'gone.ts'));
    const res = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: edited }), { workDir: edited });
    expect(res.details.filesChanged as number).toBe(1); // only keep.ts re-embedded
    expect(res.details.pruned as number).toBe(1);       // gone.ts pruned

    const db = new Database(join(dataRoot, 'codebase', 'index.db'), { readonly: true });
    const rows = db.prepare('SELECT path FROM chunks WHERE repo = ?').all(edited).map((r: { path: string }) => r.path);
    expect(rows).toContain('keep.ts');
    expect(rows).not.toContain('gone.ts');
    db.close();
  });

  it('switching the embedding model marks the repo stale and rebuilds it under the new model', async () => {
    const stale = mkdtempSync(join(tmpdir(), 'elowen-cb-stale-'));
    writeFileSync(join(stale, 'a.ts'), 'export function alpha() { return 1; } // cosine vector\n');
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: stale }), { workDir: stale });

    liveCfg = { providerId: 'p', model: 'fake-2', dimensions: VOCAB.length }; // operator switched the model
    const res = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo: stale }), { workDir: stale });
    expect(res.details.chunksEmbedded as number).toBeGreaterThan(0); // rebuilt despite no file edit

    const db = new Database(join(dataRoot, 'codebase', 'index.db'), { readonly: true });
    const models = db.prepare('SELECT DISTINCT model FROM chunks WHERE repo = ?').all(stale).map((r: { model: string }) => r.model);
    expect(models).toEqual(['fake-2']);
    db.close();
    liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length }; // restore for later tests
  });

  it('status reports per-repo coverage and the configured model', async () => {
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(reg, 'codebase_status', {}));
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain('fake-1');
    expect(res.content[0].text).toContain(repo1);
  });

  it('search returns a clear failure (not a throw) when no embedding model is configured', async () => {
    const off = mkdtempSync(join(tmpdir(), 'elowen-cb-off-'));
    const regOff = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log,
      dataRoot: off,
      embeddings: fakeEmbedder,
      embeddingConfig: () => ({ providerId: '', model: '', dimensions: null } as EmbeddingConfig),
    });
    const res = await runWithPolicy(userPolicy([repo1]), () => runTool(regOff, 'codebase_search', { query: 'anything' }));
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text.toLowerCase()).toContain('embedding');
  });
});

// ── batch3 regression fixes (#4 convergence, #5 scoping, #6 debounce, #8 latency, #9 memory) ────────────
describe('codebase plugin — batch3 fixes', () => {
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const chunkCount = (dataRoot: string, sql = 'SELECT COUNT(*) AS n FROM chunks', ...params: unknown[]): number => {
    const db = new Database(join(dataRoot, 'codebase', 'index.db'), { readonly: true });
    const n = (db.prepare(sql).get(...(params as [])) as { n: number }).n;
    db.close();
    return n;
  };

  // #4 — a budget-capped model switch must CONVERGE: each pass converts a fresh batch, so `pending`
  // strictly shrinks and the leading files are never re-embedded forever.
  it('#4 model switch converges under a per-pass budget (pending shrinks 2→1→0)', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb4-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'elowen-cb4-repo-'));
    for (const [name, word] of [['a', 'cosine'], ['b', 'vector'], ['c', 'dot']] as const)
      writeFileSync(join(repo, `${name}.ts`), `export function ${name}() { return 1; } // ${word} similarity\n`);
    let cfg: EmbeddingConfig = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log, dataRoot,
      config: { codebase: { reindexEmbedBudget: 1 } }, // one chunk per pass so files spread across passes
      embeddings: fakeEmbedder, embeddingConfig: () => cfg,
    });
    const reindex = () => runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo }), { workDir: repo });

    for (let i = 0; i < 3; i++) await reindex(); // fully index under fake-1 (3 passes @ budget 1)
    expect(chunkCount(dataRoot, "SELECT COUNT(*) AS n FROM chunks WHERE model = 'fake-1'")).toBe(3);

    cfg = { providerId: 'p', model: 'fake-2', dimensions: VOCAB.length }; // operator switches the model
    const pendings: number[] = [];
    const fake2: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await reindex();
      pendings.push(r.details.pending as number);
      fake2.push(chunkCount(dataRoot, "SELECT COUNT(*) AS n FROM chunks WHERE model = 'fake-2'"));
    }
    expect(pendings).toEqual([2, 1, 0]);  // the bug re-embeds the same leading file forever → pending stuck at 2
    expect(fake2).toEqual([1, 2, 3]);     // one more file reconverted every pass
    expect(chunkCount(dataRoot, "SELECT COUNT(*) AS n FROM chunks WHERE model = 'fake-1'")).toBe(0); // fully migrated
  });

  // #5 — auto-reindex on search is admin-only; a non-admin search must never write the index or spend the
  // embedding provider (the same effects codebase_reindex refuses to non-admins).
  it('#5 a non-admin search never triggers auto-reindex; an admin search does', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb5-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'elowen-cb5-repo-'));
    writeFileSync(join(repo, 'x.ts'), 'export function x() { return 1; } // cosine similarity vector\n');
    const cfg: EmbeddingConfig = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
    let embedBatchCalls = 0;
    const embedder = {
      embed: async (_c: EmbeddingConfig, t: string) => fakeVec(t),
      embedBatch: async (_c: EmbeddingConfig, texts: string[]) => { embedBatchCalls++; return texts.map(fakeVec); },
    };
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log, dataRoot,
      embeddings: embedder, embeddingConfig: () => cfg,
    });
    // Non-admin: no reindex, index stays empty, and a helpful failure that points at the admin tool.
    const res = await runWithPolicy(userPolicy([repo]), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector' }));
    await new Promise((r) => setTimeout(r, 60)); // give any wrongly-fired background pass time to run
    expect(embedBatchCalls).toBe(0);             // the bug fires a full reindex+embed here for a plain user
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text.toLowerCase()).toContain('admin');
    expect(chunkCount(dataRoot)).toBe(0);

    // Admin: kicks the (background) reindex → chunks appear.
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector' }), { workDir: repo });
    await waitFor(() => embedBatchCalls > 0 && chunkCount(dataRoot) > 0);
  });

  // #6 — the debounce must apply even to a repo that indexes to zero chunks (failing provider / all
  // excluded), so a persistently-empty repo can't re-walk + re-embed on every search.
  it('#6 the debounce holds for a repo that keeps indexing to zero chunks', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb6-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'elowen-cb6-repo-'));
    writeFileSync(join(repo, 'x.ts'), 'export function x() { return 1; } // cosine vector\n');
    const cfg: EmbeddingConfig = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
    let embedBatchCalls = 0;
    const embedder = {
      embed: async (_c: EmbeddingConfig, t: string) => fakeVec(t),
      embedBatch: async () => { embedBatchCalls++; throw new Error('provider down'); }, // indexing always fails → stays empty
    };
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log, dataRoot,
      embeddings: embedder, embeddingConfig: () => cfg,
    });
    const adminSearch = () => runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_search', { query: 'cosine vector' }), { workDir: repo });

    await adminSearch();                       // first search kicks a pass that fails → index still empty
    await waitFor(() => embedBatchCalls === 1);
    await new Promise((r) => setTimeout(r, 60)); // let the failed pass write its debounce marker
    await adminSearch();                       // second search within the window must NOT re-attempt
    await new Promise((r) => setTimeout(r, 120));
    expect(embedBatchCalls).toBe(1);           // the bug bypasses the debounce whenever chunk count is 0 → 2 attempts
    expect(chunkCount(dataRoot)).toBe(0);
  });

  // #8 — the search answer must not wait on a full reindex embedding pass (fire-and-forget).
  it('#8 an admin search does not block on the reindex embed pass', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb8-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'elowen-cb8-repo-'));
    writeFileSync(join(repo, 'seed.ts'), 'export function seed() { return 1; } // cosine similarity vector dot product\n');
    const cfg: EmbeddingConfig = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
    const SLOW_MS = 500;
    let slow = false;
    const embedder = {
      embed: async (_c: EmbeddingConfig, t: string) => fakeVec(t), // query embed is always fast
      embedBatch: async (_c: EmbeddingConfig, texts: string[]) => {
        if (slow) await new Promise((r) => setTimeout(r, SLOW_MS));
        return texts.map(fakeVec);
      },
    };
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log, dataRoot,
      embeddings: embedder, embeddingConfig: () => cfg,
    });
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo }), { workDir: repo }); // seed (fast)

    // Add a file so the next auto-reindex has real (slow) embedding work, and force the repo debounce-stale.
    writeFileSync(join(repo, 'fresh.ts'), 'export function fresh() { return 2; } // cosine vector\n');
    const realRepo = realpathSync(repo);
    const wdb = new Database(join(dataRoot, 'codebase', 'index.db'));
    wdb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`reindex:${realRepo}`, '0');
    wdb.close();
    slow = true;

    const t0 = Date.now();
    const res = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector dot product' }), { workDir: repo });
    const elapsed = Date.now() - t0;
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain('seed.ts');  // served from the existing index immediately
    expect(elapsed).toBeLessThan(SLOW_MS - 150);        // did NOT wait for the slow reindex embed pass
    await new Promise((r) => setTimeout(r, SLOW_MS + 120)); // let the background pass settle
  });

  // #9 / #4 — search filters by stored MODEL (not vector width) in SQL: a same-width chunk from a foreign
  // model is never cosine-compared, even when its vector is a perfect match for the query.
  it('#9/#4 search never ranks a same-width foreign-model vector', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'elowen-cb9-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'elowen-cb9-repo-'));
    writeFileSync(join(repo, 'real.ts'), 'export function real() { return 1; } // background job queue\n');
    const cfg: EmbeddingConfig = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['codebase'], logger: log, dataRoot,
      embeddings: fakeEmbedder, embeddingConfig: () => cfg,
    });
    await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_reindex', { repo }), { workDir: repo });

    // Inject a chunk from a DIFFERENT model but the SAME width, whose vector is a perfect match for the
    // query — the old width-only guard would have ranked it #1; the model filter must exclude it.
    const q = fakeVec('cosine similarity vector');
    const realRepo = realpathSync(repo);
    const wdb = new Database(join(dataRoot, 'codebase', 'index.db'));
    wdb.prepare(`INSERT INTO chunks (repo, path, start_line, end_line, symbol, body, content_hash, model, dimensions, vector)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(realRepo, 'foreign.ts', 1, 1, null, 'cosine similarity vector foreign', 'h', 'other-model', VOCAB.length, Buffer.from(q.buffer, q.byteOffset, q.byteLength));
    wdb.close();

    const res = await runWithPolicy(adminPolicy(), () => runTool(reg, 'codebase_search', { query: 'cosine similarity vector' }), { workDir: repo });
    expect(res.content[0].text).not.toContain('foreign.ts'); // excluded by the SQL model filter, not compared
  });
});
