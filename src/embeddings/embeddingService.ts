/** Resolves a configured brain provider to its credentials. Mirrors bootstrap.ts `resolveProvider`
 *  — injected via DI so this service never imports the config store directly. */
export type ProviderResolver = (
  id: string,
) => { id: string; label: string; type: string; baseUrl: string; apiKey: string | null } | null;

/** How to reach an embeddings endpoint. Either resolve credentials from a configured provider
 *  (`providerId`) or point at a local OpenAI-compatible endpoint explicitly (`baseUrl`). An explicit
 *  `baseUrl` overrides the resolved provider's. `dimensions`, when set, is forwarded to the API AND
 *  asserted against every returned vector's width. */
export interface EmbeddingConfig {
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  dimensions?: number;
}

/** The ONE definition of "embeddings are usable": a model plus some way to reach an endpoint (a
 *  configured provider OR an explicit local baseUrl — `credentials()` supports either). Shared by the
 *  embed queue (whether to embed) and MemoryService (whether to take the vector path) so the two can
 *  never disagree — a divergence silently strands one side (e.g. queue no-ops while retrieval expects
 *  vectors → empty results with no keyword fallback). */
export function isEmbeddingConfigured(cfg: EmbeddingConfig | null | undefined): boolean {
  return !!cfg && cfg.model.trim() !== '' && (!!cfg.providerId || !!cfg.baseUrl);
}

/** Hard cap on a single embeddings round-trip. A hung endpoint must not stall the caller
 *  (memory ingest / retrieval); there is no other timeout on this path. */
const EMBEDDINGS_TIMEOUT_MS = 30_000;

/** Normalize a configured base (with or without a trailing `/v1` or slash) to the embeddings URL.
 *  Mirrors src/brain/models.ts base handling + src/inference/client.ts chatUrl. */
const embeddingsUrl = (base: string) => `${base.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/embeddings`;

interface EmbeddingsResponse {
  data?: { embedding?: unknown }[];
}

/** Turns text into vectors via an OpenAI-compatible `/v1/embeddings` endpoint, reusing Orca's
 *  provider credentials. Pure network/compute — NO DB access (MemoryStore owns persistence). */
export class EmbeddingService {
  private readonly resolveProvider: ProviderResolver;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: { resolveProvider: ProviderResolver; fetchImpl?: typeof fetch }) {
    this.resolveProvider = deps.resolveProvider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Embed a single string → one Float32 vector. */
  async embed(cfg: EmbeddingConfig, text: string): Promise<Float32Array> {
    const vecs = await this.request(cfg, [text]);
    // request() guarantees data.length === input.length (1), so [0] is present.
    return vecs[0]!;
  }

  /** Embed N strings in a SINGLE request → N vectors, in input order. */
  async embedBatch(cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.request(cfg, texts);
  }

  /** Resolve credentials (explicit baseUrl wins over the resolved provider), POST the batch, and
   *  map the response to Float32Array vectors — throwing (never swallowing) on any failure. */
  private async request(cfg: EmbeddingConfig, input: string[]): Promise<Float32Array[]> {
    const { baseUrl, apiKey } = this.credentials(cfg);
    const body: { model: string; input: string[]; dimensions?: number } = { model: cfg.model, input };
    if (cfg.dimensions !== undefined) body.dimensions = cfg.dimensions;

    const res = await this.fetchImpl(embeddingsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBEDDINGS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);

    // An endpoint (or a proxy in front of it) can return 200 with a non-JSON body; res.json() would
    // then throw an opaque SyntaxError. Surface a clear error so the caller can escalate.
    let j: EmbeddingsResponse;
    try {
      j = (await res.json()) as EmbeddingsResponse;
    } catch {
      throw new Error(`embeddings returned non-JSON (HTTP ${res.status})`);
    }

    const rows = j.data;
    if (!Array.isArray(rows) || rows.length !== input.length) {
      throw new Error(`embeddings malformed response: expected ${input.length} vectors, got ${Array.isArray(rows) ? rows.length : 'none'}`);
    }
    return rows.map((row, i) => this.toVector(row?.embedding, cfg.dimensions, i));
  }

  /** Explicit `baseUrl` overrides the resolved provider. Without one, `providerId` MUST resolve. */
  private credentials(cfg: EmbeddingConfig): { baseUrl: string; apiKey: string | null } {
    if (cfg.baseUrl) return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey ?? null };
    if (!cfg.providerId) throw new Error('embeddings config requires providerId or baseUrl');
    const provider = this.resolveProvider(cfg.providerId);
    if (!provider) throw new Error(`embeddings provider not found: ${cfg.providerId}`);
    return { baseUrl: provider.baseUrl, apiKey: cfg.apiKey ?? provider.apiKey };
  }

  /** Validate one row's embedding into a Float32Array, enforcing the configured width so a
   *  wrong-length vector never reaches storage. */
  private toVector(embedding: unknown, dimensions: number | undefined, index: number): Float32Array {
    if (!Array.isArray(embedding) || !embedding.every((n): n is number => typeof n === 'number')) {
      throw new Error(`embeddings malformed response: vector ${index} is not a number[]`);
    }
    if (dimensions !== undefined && embedding.length !== dimensions) {
      throw new Error(`embeddings dimension mismatch: expected ${dimensions}, got ${embedding.length} (vector ${index})`);
    }
    return Float32Array.from(embedding);
  }
}
