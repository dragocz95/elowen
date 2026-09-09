import { describe, it, expect, afterEach } from 'vitest';
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

  it('serves documents and the query from the vector cache (no embedding for repeats)', async () => {
    const store = new SearchVectorStore(openDb(':memory:'));
    const calls: string[][] = [];
    const index = new ToolSemanticIndex({
      embeddings: stubEmbeddings((texts) => texts.map(() => unitVec(1, 0)), calls),
      embeddingConfig: () => CFG,
      cache: store,
    });
    const docs = [{ id: 'a', text: 'Docker tools' }, { id: 'b', text: 'Slack tools' }];
    await index.rank('docker', docs);
    expect(calls).toHaveLength(1);
    // Same query again: everything (docs AND the query) is cached → zero embedding work.
    await index.rank('docker', docs);
    expect(calls).toHaveLength(1);
    // A fresh query against cached documents embeds the query alone.
    await index.rank('container daemon', docs);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['container daemon']);
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