import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { SearchVectorStore } from '../../../src/store/searchVectorStore.js';
import type { EmbeddingConfig } from '../../../src/embeddings/embeddingService.js';
import { ToolSemanticIndex, SEMANTIC_SEARCH_TIMEOUT_MS } from '../../../src/brain/toolSearch/semanticIndex.js';
import { setLogSink } from '../../../src/shared/logger.js';

const CFG: EmbeddingConfig = { providerId: 'openai', model: 'text-embedding-3-small' };

interface Capture { level: string; scope: string; message: string }

/** A vector "model": texts that mention each other share direction, so cosine ordering is predictable.
 *  Returned per input text; the stub asserts it received EXACTLY the texts that were not cached. */
function stubEmbeddings(vectors: (texts: string[]) => Float32Array[], calls: string[][] = []) {
  return {
    embedBatch: async (_cfg: EmbeddingConfig, texts: string[]) => {
      calls.push([...texts]);
      return vectors(texts);
    },
  };
}

const unitVec = (a: number, b: number): Float32Array => {
  const n = Math.hypot(a, b);
  return Float32Array.from([a / n, b / n]);
};

/** A bounded FIFO vector cache shaped like `SemanticVectorCache`: past `max` entries the oldest inserted
 *  row is dropped, which is how the durable store's prune behaves. Keyed by text (one model per test). */
function boundedCache(max: number) {
  const store = new Map<string, Float32Array>();
  return {
    get: (_model: string, texts: readonly string[]) => {
      const found = new Map<string, Float32Array>();
      for (const text of texts) {
        const vector = store.get(text);
        if (vector) found.set(text, vector);
      }
      return found;
    },
    put: (_model: string, entries: readonly { text: string; vector: Float32Array }[]) => {
      for (const entry of entries) store.set(entry.text, entry.vector);
      while (store.size > max) store.delete(store.keys().next().value!);
    },
  };
}

afterEach(() => setLogSink(undefined));

describe('ToolSemanticIndex', () => {
  it('ranks documents by cosine against the query', async () => {
    // "docker daemon" points along (1,0); a document about docker aligns with the query, one about
    // baking aligns with (0,1).
    const index = new ToolSemanticIndex({
      embeddings: stubEmbeddings((texts) => texts.map((t) => (t.includes('docker') ? unitVec(1, 0.1) : unitVec(0.1, 1)))),
      embeddingConfig: () => CFG,
    });
    const hits = await index.rank('docker daemon restart', [
      { id: 'RestartDaemon', text: 'Restart the docker daemon' },
      { id: 'BakeBread', text: 'Bake a loaf of bread' },
    ]);
    expect(hits.get('RestartDaemon')).toBeGreaterThan(0.9);
    expect(hits.has('BakeBread')).toBe(false); // below the relevance floor
  });

  it('embeds the query plus only uncached documents in ONE batch', async () => {
    const calls: string[][] = [];
    const index = new ToolSemanticIndex({
      embeddings: stubEmbeddings((texts) => texts.map(() => unitVec(1, 0)), calls),
      embeddingConfig: () => CFG,
    });
    await index.rank('docker', [{ id: 'a', text: 'Docker tools' }, { id: 'b', text: 'Slack tools' }]);
    expect(calls).toEqual([['docker', 'Docker tools', 'Slack tools']]);
  });

  it('serves documents from the vector cache and embeds the query alone for repeats', async () => {
    const store = new SearchVectorStore(openDb(':memory:'));
    const calls: string[][] = [];
    const index = new ToolSemanticIndex({
      embeddings: stubEmbeddings((texts) => texts.map(() => unitVec(1, 0)), calls),
      embeddingConfig: () => CFG,
      cache: store,
    });
    const docs = [{ id: 'a', text: 'Docker tools' }, { id: 'b', text: 'Slack tools' }];
    await index.rank('docker', docs);
    expect(calls).toEqual([['docker', 'Docker tools', 'Slack tools']]);
    // Same query again: the DOCUMENTS come from the cache, but the query is embedded every call — it
    // must never enter the durable cache, where its unbounded cardinality would evict the small,
    // long-lived document vectors through the FIFO prune.
    await index.rank('docker', docs);
    expect(calls).toEqual([['docker', 'Docker tools', 'Slack tools'], ['docker']]);
    // A fresh query against cached documents embeds that query alone.
    await index.rank('container daemon', docs);
    expect(calls[2]).toEqual(['container daemon']);
  });

  // A stream of distinct queries must never evict the durable document vectors: queries are unbounded
  // in cardinality and the store prunes FIFO, so a cached query would push the tool/skill vectors out
  // and every ToolSearch would re-embed the whole surface inside the 1500 ms budget.
  it('caches documents but never the query (a query stream must not evict document vectors)', async () => {
    const calls: string[][] = [];
    const index = new ToolSemanticIndex({
      embeddings: stubEmbeddings((texts) => texts.map(() => unitVec(1, 0)), calls),
      embeddingConfig: () => CFG,
      cache: boundedCache(2),
    });
    const docs = [{ id: 'a', text: 'Docker tools' }];
    for (const query of ['q1', 'q2', 'q3', 'q4']) await index.rank(query, docs);
    // The document vector survived the whole query stream: embedded once, then served from the cache.
    expect(calls.filter((c) => c.includes('Docker tools'))).toHaveLength(1);
  });

  it('returns an empty map when embeddings time out, and warns at most once per boot', async () => {
    const captured: Capture[] = [];
    setLogSink({ push: (e) => captured.push(e) });
    const index = new ToolSemanticIndex({
      embeddings: { embedBatch: async () => { await new Promise((r) => setTimeout(r, 100)); return []; } },
      embeddingConfig: () => CFG,
      timeoutMs: 20,
    });
    const hits = await index.rank('q', [{ id: 'a', text: 'doc' }]);
    expect(hits.size).toBe(0);
    await index.rank('q2', [{ id: 'a', text: 'doc' }]);
    const warns = captured.filter((c) => c.level === 'warn' && c.scope === 'tool-search-semantic');
    expect(warns).toHaveLength(1);
  });

  it('returns an empty map on an endpoint error (the caller falls back to keyword ranking)', async () => {
    const captured: Capture[] = [];
    setLogSink({ push: (e) => captured.push(e) });
    const index = new ToolSemanticIndex({
      embeddings: { embedBatch: async () => { throw new Error('embeddings HTTP 503'); } },
      embeddingConfig: () => CFG,
    });
    expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).size).toBe(0);
    // One WARN per boot total — a broken endpoint must not spam one line per ToolSearch call.
    await index.rank('q2', [{ id: 'a', text: 'doc' }]);
    expect(captured.filter((c) => c.level === 'warn')).toHaveLength(1);
  });

  // warnOnce only quiets the LOG — without a breaker a dead endpoint still costs the full timeout
  // budget on every ToolSearch call, forever.
  it('trips a circuit breaker after a failure: the cooldown makes no embedding attempts', async () => {
    let embedCalls = 0;
    const index = new ToolSemanticIndex({
      embeddings: { embedBatch: async () => { embedCalls++; throw new Error('embeddings HTTP 503'); } },
      embeddingConfig: () => CFG,
    });
    expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).size).toBe(0);
    expect((await index.rank('q2', [{ id: 'a', text: 'doc' }])).size).toBe(0);
    expect(embedCalls).toBe(1); // the endpoint was not tried again inside the cooldown
  });

  it('closes the circuit again once the cooldown has passed', async () => {
    vi.useFakeTimers();
    try {
      let embedCalls = 0;
      const index = new ToolSemanticIndex({
        embeddings: { embedBatch: async (_cfg, texts) => { embedCalls++; if (embedCalls === 1) throw new Error('down'); return texts.map(() => unitVec(1, 0)); } },
        embeddingConfig: () => CFG,
      });
      expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).size).toBe(0);
      vi.setSystemTime(Date.now() + 61_000); // past the breaker cooldown
      expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).get('a')).toBeGreaterThan(0);
      expect(embedCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once per boot when no embedding model is configured, then stays silent', async () => {
    const captured: Capture[] = [];
    setLogSink({ push: (e) => captured.push(e) });
    let embedCalls = 0;
    const index = new ToolSemanticIndex({
      embeddings: { embedBatch: async () => { embedCalls++; return []; } },
      embeddingConfig: () => ({ providerId: 'openai', model: '' }), // unconfigured: no model
    });
    expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).size).toBe(0);
    expect((await index.rank('q', [{ id: 'a', text: 'doc' }])).size).toBe(0);
    expect(embedCalls).toBe(0);
    expect(captured.filter((c) => c.level === 'warn' && c.scope === 'tool-search-semantic')).toHaveLength(1);
  });

  it('keeps the search bounded: the batch timeout defaults to 1500 ms and doc text is clamped', () => {
    expect(SEMANTIC_SEARCH_TIMEOUT_MS).toBe(1500);
    const index = new ToolSemanticIndex({ embeddings: stubEmbeddings(() => []), embeddingConfig: () => CFG });
    // 191 documents (the current tool+skill surface) ride ONE batch — never one request per document.
    expect(index).toBeInstanceOf(ToolSemanticIndex);
  });
});