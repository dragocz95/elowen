import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { SearchVectorStore } from '../../src/store/searchVectorStore.js';
import { EmbeddingService, type ProviderResolver } from '../../src/embeddings/embeddingService.js';
import { SEARCH_MAX_CANDIDATES, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TEXT_CHARS } from '../../src/search/siteSearchRank.js';
import type { InferenceClient } from '../../src/inference/types.js';

/** The site-search surfaces the command palette calls into: `/search/rank` (embedding similarity behind
 *  the web's own lexical pass) and `/search/ask` (one cheap completion when nothing matched at all).
 *  Both are open to any authenticated user and read nothing account-scoped — the candidates arrive in
 *  the request — so what these tests pin is the degradation, the bounds and the caching, not tenancy. */

/** A 3-dim embedding space just big enough to be interesting: the query and the "steps" row point the
 *  same way, everything else is orthogonal to both. */
const VECTORS: Record<string, number[]> = {
  'how many turns at most': [1, 0, 0],
  'Maximum steps · Elowen AI · limit': [1, 0, 0],
  'Notifications · My account': [0, 1, 0],
  'Password · Security': [0, 0, 1],
};

/** A stub `/v1/embeddings` endpoint over {@link VECTORS}, recording every batch it was asked for. An
 *  unknown text embeds orthogonally to the query, so it scores itself out rather than ranking. */
function stubEmbeddings() {
  const batches: string[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
    batches.push(input);
    return new Response(
      JSON.stringify({ data: input.map((text) => ({ embedding: VECTORS[text] ?? [0, 1, 0] })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { batches, fetchImpl };
}

interface SetupOpts {
  embeddingConfigured?: boolean;
  withEmbeddingService?: boolean;
  withVectorCache?: boolean;
  fetchImpl?: typeof fetch;
  ask?: InferenceClient | null;
}

function setup(opts: SetupOpts = {}) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw'); // first user → admin
  const bob = users.create('bob', 'pw'); // a plain member: the palette is for everyone
  const config = new ConfigStore(db);
  const resolveProvider: ProviderResolver = (id) =>
    id === 'openai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test' } : null;
  if (opts.embeddingConfigured !== false) {
    config.update({ embedding: { providerId: 'openai', model: 'text-embedding-3-small', dimensions: 3 } });
  }
  const embeddings = opts.withEmbeddingService === false
    ? undefined
    : new EmbeddingService({ resolveProvider, fetchImpl: opts.fetchImpl ?? stubEmbeddings().fetchImpl });
  const app = createServer({
    bus: new EventBus(),
    project: { id: 1, path: '/o' }, clock: new FakeClock(0),
    config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    ...(embeddings ? { embeddings } : {}),
    ...(opts.withVectorCache === false ? {} : { searchVectors: new SearchVectorStore(db) }),
    ...(opts.ask === undefined ? {} : { searchAskInference: () => opts.ask ?? null }),
  });
  return { app, config, amyTok: users.issueToken(amy.id), bobTok: users.issueToken(bob.id) };
}

const post = (t: string, body: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const CANDIDATES = [
  { id: 'settings:brain:brain.maxSteps', text: 'Maximum steps · Elowen AI · limit' },
  { id: 'account:notifications', text: 'Notifications · My account' },
  { id: 'account:security', text: 'Password · Security' },
];
const QUERY = 'how many turns at most';

describe('POST /search/rank', () => {
  it('503s embeddings-not-configured when no embedding provider is set, and when none is wired at all', async () => {
    const unconfigured = setup({ embeddingConfigured: false });
    const res = await unconfigured.app.request('/search/rank', post(unconfigured.amyTok, { query: QUERY, candidates: CANDIDATES }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'embeddings-not-configured' });

    // Configured in settings but no embedder in this process (minimal wiring) is the same answer: the
    // web has one code to recognize, not two.
    const unwired = setup({ withEmbeddingService: false });
    const second = await unwired.app.request('/search/rank', post(unwired.amyTok, { query: QUERY, candidates: CANDIDATES }));
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: 'embeddings-not-configured' });
  });

  it('ranks the candidates by similarity, dropping the ones below the floor', async () => {
    const { fetchImpl } = stubEmbeddings();
    const { app, bobTok } = setup({ fetchImpl });
    const res = await app.request('/search/rank', post(bobTok, { query: QUERY, candidates: CANDIDATES }));

    expect(res.status).toBe(200);
    const { results } = await res.json() as { results: { id: string; score: number }[] };
    expect(results.map((hit) => hit.id)).toEqual(['settings:brain:brain.maxSteps']);
    expect(results[0]!.score).toBeCloseTo(1, 5);
  });

  it('caches candidate vectors durably — the second call embeds only the query', async () => {
    const { batches, fetchImpl } = stubEmbeddings();
    const { app, amyTok } = setup({ fetchImpl });

    await app.request('/search/rank', post(amyTok, { query: QUERY, candidates: CANDIDATES }));
    expect(batches[0]).toEqual([QUERY, ...CANDIDATES.map((candidate) => candidate.text)]);

    const second = await app.request('/search/rank', post(amyTok, { query: 'another question', candidates: CANDIDATES }));
    expect(second.status).toBe(200);
    expect(batches[1]).toEqual(['another question']);
  });

  it('re-embeds every candidate when no vector cache is wired', async () => {
    const { batches, fetchImpl } = stubEmbeddings();
    const { app, amyTok } = setup({ fetchImpl, withVectorCache: false });
    await app.request('/search/rank', post(amyTok, { query: QUERY, candidates: CANDIDATES }));
    await app.request('/search/rank', post(amyTok, { query: QUERY, candidates: CANDIDATES }));
    expect(batches[1]).toHaveLength(1 + CANDIDATES.length);
  });

  it('rejects an over-limit query, candidate list or candidate text with 400', async () => {
    const { app, amyTok } = setup();
    const long = (n: number) => 'x'.repeat(n);

    const tooManyCandidates = Array.from({ length: SEARCH_MAX_CANDIDATES + 1 }, (_, i) => ({ id: `id-${i}`, text: `t-${i}` }));
    for (const [label, body] of [
      ['query', { query: long(SEARCH_MAX_QUERY_CHARS + 1), candidates: CANDIDATES }],
      ['candidates', { query: QUERY, candidates: tooManyCandidates }],
      ['text', { query: QUERY, candidates: [{ id: 'a', text: long(SEARCH_MAX_TEXT_CHARS + 1) }] }],
      ['empty query', { query: '   ', candidates: CANDIDATES }],
    ] as const) {
      const res = await app.request('/search/rank', post(amyTok, body));
      expect(res.status, `over-limit ${label} must be refused`).toBe(400);
    }

    // Exactly at the limits is accepted — the bound is a cap, not an off-by-one.
    const atLimit = await app.request('/search/rank', post(amyTok, {
      query: long(SEARCH_MAX_QUERY_CHARS),
      candidates: Array.from({ length: SEARCH_MAX_CANDIDATES }, (_, i) => ({ id: `id-${i}`, text: long(SEARCH_MAX_TEXT_CHARS) })),
    }));
    expect(atLimit.status).toBe(200);
  });

  it('rate-limits one account without touching another', async () => {
    const { app, amyTok, bobTok } = setup();
    const body = { query: QUERY, candidates: CANDIDATES };
    let limitedAt = 0;
    for (let i = 1; i <= 40 && limitedAt === 0; i++) {
      const res = await app.request('/search/rank', post(amyTok, body));
      if (res.status === 429) { limitedAt = i; expect(await res.json()).toEqual({ error: 'rate-limited' }); }
    }
    expect(limitedAt).toBe(31); // 30 per minute, the 31st is refused

    // Bob's budget is his own.
    expect((await app.request('/search/rank', post(bobTok, body))).status).toBe(200);
  });

  it('answers 503 rather than 500 when the embedding provider fails', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { app, amyTok } = setup({ fetchImpl: failing });
    const res = await app.request('/search/rank', post(amyTok, { query: QUERY, candidates: CANDIDATES }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'embeddings-unavailable' });
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = setup();
    const res = await app.request('/search/rank', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, candidates: CANDIDATES }),
    });
    expect(res.status).toBe(401);
  });
});

const ASK_CANDIDATES = [
  { id: 'settings:brain:brain.maxSteps', title: 'Maximum steps', subtitle: 'Elowen AI' },
  { id: 'page:memory', title: 'Memory' },
  { id: 'account:security', title: 'Security', subtitle: 'My account' },
];

/** An inference stub that records the prompt and the abort signal it was handed. */
function stubAsk(reply: string | (() => Promise<never>)) {
  const calls: { prompt: string; signal?: AbortSignal }[] = [];
  const client: InferenceClient = {
    model: 'test-model',
    decide: async (prompt, opts) => {
      calls.push({ prompt, ...(opts?.signal ? { signal: opts.signal } : {}) });
      if (typeof reply !== 'string') return reply();
      return { text: reply };
    },
  };
  return { calls, client };
}

describe('POST /search/ask', () => {
  it('503s model-not-configured when the categorization route is unset', async () => {
    const { app, amyTok } = setup({ ask: null });
    const res = await app.request('/search/ask', post(amyTok, { query: 'where do I cap the steps', candidates: ASK_CANDIDATES }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'model-not-configured' });

    // Same answer when the dependency is not wired at all.
    const unwired = setup();
    expect((await unwired.app.request('/search/ask', post(unwired.amyTok, { query: 'q', candidates: ASK_CANDIDATES }))).status).toBe(503);
  });

  it('returns the model\'s picks, dropping ids that were never offered', async () => {
    const { calls, client } = stubAsk('["page:memory","page:invented","settings:brain:brain.maxSteps"]');
    const { app, bobTok } = setup({ ask: client });
    const res = await app.request('/search/ask', post(bobTok, { query: 'where do I cap the steps', candidates: ASK_CANDIDATES }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ id: 'page:memory' }, { id: 'settings:brain:brain.maxSteps' }] });
    // The prompt carries the candidate lines and the query, so the model reads what the user would have.
    expect(calls[0]!.prompt).toContain('settings:brain:brain.maxSteps — Maximum steps · Elowen AI');
    expect(calls[0]!.prompt).toContain('Query: where do I cap the steps');
  });

  it('answers nothing for a reply that is not a JSON array of ids', async () => {
    for (const reply of ['I think you want Settings.', '{"id":"page:memory"}', '[1,2,3]', '']) {
      const { client } = stubAsk(reply);
      const { app, amyTok } = setup({ ask: client });
      const res = await app.request('/search/ask', post(amyTok, { query: 'q', candidates: ASK_CANDIDATES }));
      expect(res.status, `reply ${JSON.stringify(reply)} must not 500`).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
  });

  it('caps the answer at five ids and keeps the model\'s order', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `row-${i}`, title: `Row ${i}` }));
    const { client } = stubAsk(JSON.stringify(many.map((row) => row.id).reverse()));
    const { app, amyTok } = setup({ ask: client });
    const { results } = await (await app.request('/search/ask', post(amyTok, { query: 'q', candidates: many }))).json() as { results: { id: string }[] };
    expect(results.map((hit) => hit.id)).toEqual(['row-7', 'row-6', 'row-5', 'row-4', 'row-3']);
  });

  // The deadline is the route's, not the completion stack's: `piInferenceClient`'s own ceiling is three
  // minutes, which is a background budget and not something a user watches a spinner through. What is
  // pinned here is that a signal is HANDED OVER (deleting it is the regression) and that an abort
  // surfaces as the same 503 every other ask failure does. The 15 s expiry itself is not exercised — it
  // would cost 15 s of wall clock — so it is asserted as the constant the route passes.
  it('hands the completion an abort signal and turns a timeout into 503', async () => {
    const timeout = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const { calls, client } = stubAsk(timeout as () => Promise<never>);
    const { app, amyTok } = setup({ ask: client });
    const res = await app.request('/search/ask', post(amyTok, { query: 'q', candidates: ASK_CANDIDATES }));

    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signal!.aborted).toBe(false);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ask-failed' });
  });

  it('applies the same bounds as /search/rank', async () => {
    const { client } = stubAsk('[]');
    const { app, amyTok } = setup({ ask: client });
    const long = 'x'.repeat(SEARCH_MAX_TEXT_CHARS + 1);
    for (const body of [
      { query: 'x'.repeat(SEARCH_MAX_QUERY_CHARS + 1), candidates: ASK_CANDIDATES },
      { query: 'q', candidates: Array.from({ length: SEARCH_MAX_CANDIDATES + 1 }, (_, i) => ({ id: `id-${i}`, title: 't' })) },
      { query: 'q', candidates: [{ id: 'a', title: long }] },
      { query: 'q', candidates: [{ id: 'a', title: 'ok', subtitle: long }] },
    ]) {
      expect((await app.request('/search/ask', post(amyTok, body))).status).toBe(400);
    }
  });

  it('rate-limits more tightly than ranking', async () => {
    const { client } = stubAsk('[]');
    const { app, amyTok } = setup({ ask: client });
    const body = { query: 'q', candidates: ASK_CANDIDATES };
    let limitedAt = 0;
    for (let i = 1; i <= 20 && limitedAt === 0; i++) {
      if ((await app.request('/search/ask', post(amyTok, body))).status === 429) limitedAt = i;
    }
    expect(limitedAt).toBe(11); // 10 per minute
  });

  it('never logs the query text', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = stubAsk(() => Promise.reject(new Error('provider exploded')));
    const { app, amyTok } = setup({ ask: client });
    await app.request('/search/ask', post(amyTok, { query: 'a-very-private-search-string', candidates: ASK_CANDIDATES }));
    const written = [...spy.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(written).not.toContain('a-very-private-search-string');
    spy.mockRestore();
    warn.mockRestore();
  });
});
