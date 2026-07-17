import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { EmbeddingConfig } from '../../src/embeddings/embeddingService.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginEntry = join(repoRoot, 'plugins/elowen-docs/index.mjs');

type ToolResult = { content: { text: string }[]; details: Record<string, unknown> };
const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>): Promise<ToolResult> => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<ToolResult> }).execute('t', params);
};

// A deterministic bag-of-words "embedder" (the codebase plugin's harness idiom): real cosine ranking,
// zero network. Shared vocabulary between a query and a section → a higher score.
const VOCAB = ['autonomy', 'agent', 'approve', 'plugin', 'install', 'model', 'memory', 'embedding', 'setting', 'configure', 'cron', 'schedule', 'token', 'session', 'workflow'];
const fakeVec = (text: string): Float32Array => {
  const t = text.toLowerCase();
  return Float32Array.from(VOCAB.map((w) => (t.match(new RegExp(w, 'g'))?.length ?? 0)));
};
let embedBatchCalls = 0;
const fakeEmbedder = {
  embed: async (_cfg: EmbeddingConfig, text: string) => fakeVec(text),
  embedBatch: async (_cfg: EmbeddingConfig, texts: string[]) => { embedBatchCalls += 1; return texts.map(fakeVec); },
};

describe('elowen-docs — pure helpers', () => {
  const load = async () => (await import(pluginEntry)) as {
    chunkMarkdown: (t: string, path: string) => { heading: string; docTitle: string; startLine: number; body: string }[];
    stripFrontmatter: (t: string) => { body: string; title: string };
    corpusFingerprint: (files: { path: string; text: string }[], model: string, dims: number | null) => string;
    keywordRank: (chunks: { docTitle: string; heading: string; body: string }[], q: string, k: number) => { score: number; heading: string }[];
    resolveDocsRoot: (from?: string) => string | null;
    readCorpus: (root: string) => { path: string; text: string }[];
    cosine: (a: Float32Array, b: Float32Array) => number;
  };

  it('splits a page into one section per heading, carrying the heading path', async () => {
    const { chunkMarkdown } = await load();
    const md = [
      '---', 'title: Agents and autonomy', 'slug: agents', '---', '',
      '# Agents and autonomy', 'Intro prose.', '',
      '## Autonomy levels', 'How far an agent may go alone.', '',
      '### Approving tools', 'Approve each call.', '',
      '## Limits', 'Turn budgets.',
    ].join('\n');
    const chunks = chunkMarkdown(md, 'docs/site/04-agents-autonomy.md');

    expect(chunks.map((c) => c.heading)).toEqual([
      'Agents and autonomy',
      'Agents and autonomy › Autonomy levels',
      'Agents and autonomy › Autonomy levels › Approving tools',
      'Agents and autonomy › Limits',
    ]);
    expect(chunks.every((c) => c.docTitle === 'Agents and autonomy')).toBe(true);
    expect(chunks[1]!.body).toBe('How far an agent may go alone.');
    // Frontmatter is metadata, not documentation — indexing it would rank pages on their own slugs.
    expect(chunks.some((c) => c.body.includes('slug:'))).toBe(false);
  });

  it('does not mistake a shell comment inside a fenced code block for a heading', async () => {
    // The manual's install page opens ```bash blocks whose comments start with '#'. Parsed as headings
    // they reset the trail and re-parent every later section under a shell comment — and the fabricated
    // segment is embedded into those sections' vectors, so it corrupts retrieval, not just the label.
    const { chunkMarkdown } = await load();
    const md = [
      '# Install', '', '## Linux', '', '```bash', '# Linux (Debian/Ubuntu)', 'apt install elowen', '```', '',
      '## Docker', 'Run the image.',
    ].join('\n');
    const chunks = chunkMarkdown(md, 'docs/site/02-install.md');

    expect(chunks.map((c) => c.heading)).toEqual(['Install › Linux', 'Install › Docker']);
    expect(chunks[0]!.body).toContain('apt install elowen');   // the block stays in its section
  });

  it('keeps every section of the real install page rooted at the page title', async () => {
    // The regression that motivated fence tracking, pinned against the actual shipped corpus rather than
    // a synthetic string: 16 of 130 sections were re-parented under "# Windows — installs into WSL2 …".
    const { chunkMarkdown, resolveDocsRoot, readCorpus } = await load();
    const corpus = readCorpus(resolveDocsRoot()!);
    for (const file of corpus) {
      const chunks = chunkMarkdown(file.text, file.path);
      const orphans = chunks.filter((c) => c.heading !== c.docTitle && !c.heading.startsWith(`${c.docTitle} › `));
      expect(orphans.map((o) => `${file.path}: ${o.heading}`)).toEqual([]);
    }
  });

  it('nests a heading after a skipped level under its parent, not its sibling', async () => {
    // The trail is indexed BY LEVEL, so h1 -> h3 leaves a hole. Compacting it in place would put the h3
    // at index 1 and the NEXT h3 would keep its own sibling as a parent — wrong for the rest of the doc.
    const { chunkMarkdown } = await load();
    const md = '# Top\n\n### Alpha\na\n\n### Beta\nb\n\n### Gamma\nc\n\n## Real\nd';
    expect(chunkMarkdown(md, 'docs/site/01-x.md').map((c) => c.heading)).toEqual([
      'Top › Alpha', 'Top › Beta', 'Top › Gamma', 'Top › Real',
    ]);
  });

  it('reads the title from frontmatter, and falls back to the first heading without it', async () => {
    const { stripFrontmatter, chunkMarkdown } = await load();
    expect(stripFrontmatter('---\ntitle: "Quoted"\n---\nbody').title).toBe('Quoted');
    expect(stripFrontmatter('no frontmatter').body).toBe('no frontmatter');
    expect(chunkMarkdown('# Only heading\ntext', 'docs/site/01-x.md')[0]!.docTitle).toBe('Only heading');
  });

  it('splits an over-long section but keeps every part under the same heading', async () => {
    const { chunkMarkdown } = await load();
    const para = `${'word '.repeat(120)}\n\n`;
    const chunks = chunkMarkdown(`# T\n\n## Long\n${para.repeat(6)}`, 'docs/site/01-x.md');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === 'T › Long')).toBe(true);
    expect(chunks.every((c) => c.body.length <= 1500)).toBe(true);
  });

  it('fingerprints the corpus AND the model, so either one changing invalidates the index', async () => {
    const { corpusFingerprint } = await load();
    const files = [{ path: 'a.md', text: 'x' }, { path: 'b.md', text: 'y' }];
    const base = corpusFingerprint(files, 'm1', 8);

    expect(corpusFingerprint(files, 'm1', 8)).toBe(base);                                      // stable
    expect(corpusFingerprint([...files].reverse(), 'm1', 8)).toBe(base);                       // order-independent
    expect(corpusFingerprint([{ path: 'a.md', text: 'CHANGED' }, files[1]!], 'm1', 8)).not.toBe(base); // an upgrade
    expect(corpusFingerprint(files, 'm2', 8)).not.toBe(base);                                  // a model switch
    expect(corpusFingerprint(files, 'm1', 16)).not.toBe(base);                                 // a width switch
  });

  it('keywordRank weighs a heading above prose and returns nothing for an unmatched query', async () => {
    const { keywordRank } = await load();
    const chunks = [
      { docTitle: 'Configuration', heading: 'Configuration › Embedding model', body: 'Pick a provider.' },
      { docTitle: 'CLI', heading: 'CLI › Keybinds', body: 'The embedding model is unrelated here.' },
    ];
    const hits = keywordRank(chunks, 'embedding model', 2);
    expect(hits[0]!.heading).toContain('Embedding model');   // heading match outranks a body mention
    expect(hits).toHaveLength(2);
    expect(keywordRank(chunks, 'zzzz', 2)).toEqual([]);
    expect(keywordRank(chunks, '', 2)).toEqual([]);
  });

  it('finds the real shipped manual from the plugin\'s own location', async () => {
    const { resolveDocsRoot, readCorpus } = await load();
    const root = resolveDocsRoot();
    expect(root).toBe(join(repoRoot, 'docs/site'));

    const corpus = readCorpus(root!);
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    expect(corpus.every((f) => /^docs\/site\/\d{2}-[a-z0-9-]+\.md$/.test(f.path))).toBe(true);
    // Never the private planning docs, and never the images directory.
    expect(corpus.some((f) => /superpowers|plans|images|_DOCS_AUDIT/i.test(f.path))).toBe(false);
  });

  it('gives up cleanly when there is no manual next to it, rather than guessing a directory', async () => {
    const { resolveDocsRoot } = await load();
    expect(resolveDocsRoot(mkdtempSync(join(tmpdir(), 'elowen-nodocs-')))).toBeNull();
  });
});

describe('elowen-docs — search', () => {
  let dataRoot: string;
  let liveCfg: EmbeddingConfig | null;

  const loadReg = (root = dataRoot) => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['elowen-docs'], logger: log,
    dataRoot: root,
    embeddings: fakeEmbedder,
    embeddingConfig: () => liveCfg,
  });

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'elowen-docs-data-'));
    liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
  });
  afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

  it('ranks real manual sections for a natural-language question', async () => {
    const reg = await loadReg();
    const res = await runTool(reg, 'ElowenDocs', { query: 'how do I limit what an agent may do on its own?' });

    expect(res.details.ok).toBe(true);
    expect(res.details.mode).toBe('semantic');
    expect(res.details.matches).toBeGreaterThan(0);
    // Every hit names the page and the heading it came from — that IS the "where is this" answer.
    expect(res.content[0]!.text).toMatch(/docs\/site\/\d{2}-[a-z0-9-]+\.md/);
    // A URL would be a guess: this repo does not define the published link scheme.
    expect(res.content[0]!.text).not.toContain('http');
  });

  it('embeds the corpus once and reuses the index on later calls', async () => {
    const reg = await loadReg();
    embedBatchCalls = 0;
    await runTool(reg, 'ElowenDocs', { query: 'install' });
    const afterFirst = embedBatchCalls;
    await runTool(reg, 'ElowenDocs', { query: 'plugin' });
    // The corpus is immutable between releases; re-embedding it per search would spend the provider for
    // nothing. Only the QUERY is embedded after the first build (embed, not embedBatch).
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it('rebuilds under a new embedding model rather than scoring against stale vectors', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'elowen-docs-switch-'));
    try {
      liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
      await runTool(await loadReg(fresh), 'ElowenDocs', { query: 'autonomy' });
      embedBatchCalls = 0;

      liveCfg = { providerId: 'p', model: 'fake-2', dimensions: VOCAB.length };
      const res = await runTool(await loadReg(fresh), 'ElowenDocs', { query: 'autonomy' });
      expect(embedBatchCalls).toBeGreaterThan(0);       // the model moved → the index is rebuilt
      expect(res.details.model).toBe('fake-2');
    } finally {
      liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('falls back to keyword search when no embedding model is configured, and says so', async () => {
    const off = mkdtempSync(join(tmpdir(), 'elowen-docs-off-'));
    try {
      liveCfg = null;   // a fresh install: nothing configured yet
      const res = await runTool(await loadReg(off), 'ElowenDocs', { query: 'plugin install' });

      // Degraded, never dead: "how do I set this up?" is exactly the question asked before a model exists.
      expect(res.details.ok).toBe(true);
      expect(res.details.mode).toBe('keyword');
      expect(res.content[0]!.text).toMatch(/embedding model/i);
    } finally {
      liveCfg = { providerId: 'p', model: 'fake-1', dimensions: VOCAB.length };
      rmSync(off, { recursive: true, force: true });
    }
  });

  it('returns the best sections by rank, with no absolute score cutoff', async () => {
    // Measured against the shipped manual and a real embedding model: "how do I install Elowen?" scores
    // HALF the corpus above 0.3, while "co je to mise?" — a perfectly good question — peaks at 0.148. A
    // fixed floor therefore floods or silently returns nothing depending on the question's language, and
    // the number would differ per model. The ORDER is what holds, so rank and cap. Do not add a floor
    // back without measuring first.
    const reg = await loadReg();
    const weak = await runTool(reg, 'ElowenDocs', { query: 'agent', k: 4 });
    expect(weak.details.matches).toBe(4);

    const text = weak.content[0]!.text;
    const scores = [...text.matchAll(/\((\d\.\d{3})\)/g)].map((m) => Number(m[1]));
    expect(scores).toHaveLength(4);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));   // best first
    expect(text).toMatch(/do not read them as absolute confidence/i);
  });

  it('rejects an empty query instead of ranking the whole manual', async () => {
    const res = await runTool(await loadReg(), 'ElowenDocs', { query: '   ' });
    expect(res.details.ok).toBe(false);
    expect(res.content[0]!.text).toMatch(/query is required/);
  });
});

describe('elowen-docs — packaging', () => {
  it('ships every indexed page, and nothing private, in the npm package', () => {
    // The plugin indexes what is on disk next to the install. If `files` stopped matching the manual, the
    // tool would silently find nothing on a real install while passing every test in this repo.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('docs/site/*.md');

    const shipped = readdirSync(join(repoRoot, 'docs/site')).filter((f) => f.endsWith('.md'));
    expect(shipped.length).toBeGreaterThanOrEqual(12);
    // An allowlist of numbered pages, so an internal note dropped into docs/ can never reach a package.
    // `docs/_DOCS_AUDIT.md` is gitignored and untracked, and a broader `docs/*.md` glob WOULD publish it.
    expect(pkg.files.some((f) => f === 'docs/*.md' || f === 'docs/**')).toBe(false);
    expect(pkg.files.some((f) => f.includes('superpowers') || f.includes('plans'))).toBe(false);
  });

  // The result is reference material the model reads to answer in its own words — a wall of doc prose
  // dumped into the chat buries the answer the reader actually wanted. Tool output is hidden unless a
  // manifest opts in, so the fix is the absence of an opt-in; this asserts nobody re-adds one. The
  // built-in control-plane and memory tools are left out of their own show list for the same reason.
  it('shows a marker in the transcript, never the search result itself', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'plugins/elowen-docs/elowen-plugin.json'), 'utf8'),
    ) as { showOutput?: string[] };
    expect(manifest.showOutput ?? []).toEqual([]);
  });
});
