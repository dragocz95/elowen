import { parseBody } from '../validation.js';
import { searchAskSchema, searchRankSchema } from '../schemas/search.js';
import { toEmbeddingConfig } from '../../store/configStore.js';
import { isEmbeddingConfigured } from '../../embeddings/embeddingService.js';
import { rankSiteSearch } from '../../search/siteSearchRank.js';
import { buildAskPrompt, parseAskReply, SEARCH_ASK_TIMEOUT_MS } from '../../search/siteSearchAsk.js';
import type { ElowenApp, RouteContext } from '../context.js';

/** Per-user request budgets, per minute. The palette calls `/search/rank` on a 300 ms debounce while the
 *  user types, so a real session lands a handful of calls; `/search/ask` is one deliberate click and
 *  costs a model round-trip, hence the much tighter budget. */
const RANK_PER_MINUTE = 30;
const ASK_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

/** A fixed-window counter, one instance per surface, mirroring `loginRateLimit.ts` — the pattern the
 *  routes already use. In-memory and per-process on purpose: this bounds one daemon's own work, it is
 *  not a security control, and a restart resetting it costs nothing. */
function createWindowLimiter(max: number): (key: string, now: number) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key, now) => {
    // Opportunistic sweep so an instance with many accounts cannot grow the map without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    }
    const hit = hits.get(key);
    if (!hit || now >= hit.resetAt) {
      hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return false;
    }
    hit.count++;
    return hit.count > max;
  };
}

/** Site-wide search assistance for the command palette, behind the lexical search the web does itself.
 *
 *  Both routes are open to ANY authenticated user — the palette is how everyone moves around the app —
 *  and neither reads or writes anything account-scoped: the candidates arrive in the request and the
 *  answer is a subset of them. The daemon's contribution is the two things a browser cannot do, an
 *  embedding endpoint and a model.
 *
 *  An unconfigured instance answers 503 with a machine-readable code rather than an empty list, so the
 *  web can tell "no semantic layer here" from "nothing matched" and disable the layer silently instead
 *  of showing a user an error about a feature they never asked for.
 *
 *  QUERY TEXT IS NEVER LOGGED above debug: it is what a person typed into a search box, and the routes
 *  have no reason to keep it. Failures are logged by shape and count only. */
export function registerSearchRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, log } = ctx;
  const rankLimited = createWindowLimiter(RANK_PER_MINUTE);
  const askLimited = createWindowLimiter(ASK_PER_MINUTE);

  // Rank the caller's candidates against their query by embedding similarity. Candidate vectors are
  // cached durably (search_vectors), keyed by model+text, so a steady-state call embeds ONLY the query.
  app.post('/search/rank', async (c) => {
    if (rankLimited(String(c.get('user').id), Date.now())) return c.json({ error: 'rate-limited' }, 429);
    const body = await parseBody(c, searchRankSchema);
    const cfg = toEmbeddingConfig(d.config.embeddingConfig());
    // Embeddings need an API-key provider; an OAuth-only instance legitimately has none. The web treats
    // this exact code as "there is no semantic layer" and stops asking for the rest of the session.
    if (!d.embeddings || !isEmbeddingConfigured(cfg)) return c.json({ error: 'embeddings-not-configured' }, 503);
    const embeddings = d.embeddings;
    try {
      const results = await rankSiteSearch(
        {
          embedBatch: (texts) => embeddings.embedBatch(cfg, texts),
          model: cfg.model,
          ...(d.searchVectors ? { cache: d.searchVectors } : {}),
        },
        body.query,
        body.candidates,
      );
      return c.json({ results });
    } catch (err) {
      // A provider failure is the semantic layer being unavailable right now, not a broken request —
      // same 503 the unconfigured case answers, so the web has one thing to handle.
      log.warn('site search ranking failed', { candidates: body.candidates.length, error: String(err) });
      return c.json({ error: 'embeddings-unavailable' }, 503);
    }
  });

  // Ask the workspace's cheap model which candidates answer the query. Used only when nothing matched at
  // all, and only on an explicit click — never on a keystroke.
  app.post('/search/ask', async (c) => {
    if (askLimited(String(c.get('user').id), Date.now())) return c.json({ error: 'rate-limited' }, 429);
    const body = await parseBody(c, searchAskSchema);
    const inference = d.searchAskInference?.() ?? null;
    if (!inference) return c.json({ error: 'model-not-configured' }, 503);
    try {
      const { text } = await inference.decide(
        buildAskPrompt(body.query, body.candidates),
        { signal: AbortSignal.timeout(SEARCH_ASK_TIMEOUT_MS) },
      );
      // Ids the model invented are dropped here, not followed — see parseAskReply.
      return c.json({ results: parseAskReply(text, body.candidates).map((id) => ({ id })) });
    } catch (err) {
      log.warn('site search ask failed', { model: inference.model, error: String(err) });
      return c.json({ error: 'ask-failed' }, 503);
    }
  });
}
