import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/** How many cached vectors the table keeps. The site-search index is a few hundred short strings per
 *  locale, so this holds every locale's whole index many times over and still stays a rounding error
 *  next to the message log (a 1536-wide Float32 vector is 6 KB, so the cap is ~30 MB at the widest
 *  models in use and far less at the 768/1024-wide ones). Past it the OLDEST inserted rows are dropped:
 *  this is a cache, so an eviction costs one re-embed and nothing else. */
export const SEARCH_VECTOR_CACHE_MAX = 5000;

/** The cache key: sha256 of the embedding model and the exact text, NUL-separated so no model/text pair
 *  can collide with another by concatenation. The model belongs in the KEY rather than in a filter —
 *  changing it must miss, not return a vector from a different (possibly different-width) space. */
export function searchVectorKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}\0${text}`, 'utf8').digest('hex');
}

/** Durable cache of embedding vectors for the site-search index. Not user-scoped: the cached texts are
 *  the application's own interface strings, identical for every account.
 *
 *  Pure persistence — it makes no embedding calls of its own (that is EmbeddingService) and holds no
 *  policy about WHICH texts are worth caching (that is siteSearchRank). */
export class SearchVectorStore {
  constructor(private db: Db) {}

  /** Cached vectors for `texts` under `model`, keyed by the ORIGINAL text so the caller can pair them
   *  back up without recomputing hashes. A text with no cached vector is simply absent from the map. */
  get(model: string, texts: readonly string[]): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>();
    if (texts.length === 0) return found;
    // Key → text, so a row can be mapped back; duplicates in `texts` collapse onto one key, which is
    // what we want (one lookup, one entry).
    const byKey = new Map(texts.map((text) => [searchVectorKey(model, text), text]));
    const keys = [...byKey.keys()];
    const rows = this.db.prepare(
      `SELECT key, vector FROM search_vectors WHERE key IN (${keys.map(() => '?').join(',')})`,
    ).all(...keys) as { key: string; vector: Buffer }[];
    for (const row of rows) {
      const text = byKey.get(row.key);
      if (text === undefined) continue;
      // Copy the slice the Buffer actually views: a Buffer from better-sqlite3 can sit at a non-zero
      // byteOffset inside a larger pool, and handing that raw ArrayBuffer to Float32Array would read
      // the neighbouring rows' bytes instead.
      found.set(text, new Float32Array(row.vector.buffer.slice(
        row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength,
      )));
    }
    return found;
  }

  /** Store vectors for `model` and prune back to {@link SEARCH_VECTOR_CACHE_MAX}. One transaction, so a
   *  concurrent reader never sees the table over its cap or half-written. Re-storing a key is a no-op on
   *  the row (the key IS the content hash, so the vector cannot have changed) — which also keeps the
   *  original insertion age, so a long-lived entry does not keep renewing its lease against eviction. */
  put(model: string, entries: readonly { text: string; vector: Float32Array }[]): void {
    if (entries.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO search_vectors (key, model, dims, vector) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const entry of entries) {
        insert.run(
          searchVectorKey(model, entry.text),
          model,
          entry.vector.length,
          Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength),
        );
      }
      this.prune();
    })();
  }

  /** Drop the oldest rows until the table is back within the cap. `rowid` breaks the `created_at` tie:
   *  the timestamp has one-second resolution, so a burst of inserts is otherwise unordered and eviction
   *  would pick arbitrarily among them. */
  private prune(): void {
    const excess = this.count() - SEARCH_VECTOR_CACHE_MAX;
    if (excess <= 0) return;
    this.db.prepare(
      `DELETE FROM search_vectors WHERE rowid IN (
         SELECT rowid FROM search_vectors ORDER BY created_at ASC, rowid ASC LIMIT ?
       )`,
    ).run(excess);
  }

  /** How many vectors are cached. Used by the pruning above and by the store's own test. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM search_vectors').get() as { n: number }).n;
  }
}
