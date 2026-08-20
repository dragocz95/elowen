// Web plugin: search (Tavily or Serper) + page fetch as readable text, sized for the embedded brain.
// WebFetch needs no API key; WebSearch politely explains when none is set.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const SNIPPET_CHARS = 300;
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Private/loopback/link-local guard: the brain must not be a proxy into the host's internal network. */
function isPrivate(ip) {
  const v = ip.toLowerCase();
  const v4 = v.startsWith('::ffff:') ? v.slice(7) : v; // unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1)
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4)
    || v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd');
}

async function assertPublicHttpUrl(raw, base) {
  const url = base ? new URL(raw, base) : new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  const host = url.hostname;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivate(a.address))) throw new Error('URL resolves to a private address');
  return url;
}

/** Fetch that follows redirects MANUALLY so every hop's Location is re-validated against the same
 *  private/loopback guard — a public URL must not be able to 302 the brain into 127.0.0.1:4400 or a
 *  cloud metadata endpoint. Capped at MAX_REDIRECTS hops. */
async function fetchGuarded(startUrl, init) {
  let url = await assertPublicHttpUrl(startUrl);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res; // 3xx without a target — let the caller surface the status
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    url = await assertPublicHttpUrl(location, url); // resolve relative + re-validate against the blocklist
  }
}

/** Very small readable-text extraction: drop script/style/nav noise, strip tags, decode the common
 *  entities, collapse whitespace. Not a DOM parser by design — no dependencies, good enough for LLMs. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The search backends, each mapping its own response onto ONE normalized shape
 *  ({ answer, results: [{ title, url, snippet }] }) so the formatting below — and therefore what the
 *  brain reads — stays identical whichever backend answered. */
export const SEARCH_PROVIDERS = {
  tavily: {
    label: 'Tavily',
    keyField: 'tavilyApiKey',
    async search(apiKey, query, maxResults) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: true }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
      const data = await res.json();
      return {
        answer: data.answer ?? '',
        results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      };
    },
  },
  serper: {
    label: 'Serper',
    keyField: 'serperApiKey',
    async search(apiKey, query, maxResults) {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`serper HTTP ${res.status}`);
      const data = await res.json();
      // Serper mirrors the Google SERP: a direct answer arrives as answerBox (`answer` for a plain
      // value, `snippet` for a featured paragraph), and a card-style result as knowledgeGraph. Tavily's
      // `answer` has no equivalent otherwise, so this keeps the two backends' output comparable.
      const box = data.answerBox ?? {};
      const graph = data.knowledgeGraph ?? {};
      return {
        answer: box.answer || box.snippet || graph.description || '',
        results: (data.organic ?? []).slice(0, maxResults)
          .map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })),
      };
    },
  },
};

/** Backends in preference order for the automatic choice. Tavily first so an install that only ever
 *  had a Tavily key keeps behaving exactly as it did before Serper existed. */
const PROVIDER_ORDER = ['tavily', 'serper'];

/** Which backend answers, and with which key — or a `message` explaining what the operator must fix.
 *  Returning the explanation (rather than throwing) keeps a misconfiguration a readable tool result
 *  the brain can act on instead of an error it will retry. */
export function resolveSearchProvider(config = {}) {
  const keyOf = (field) => (typeof config[field] === 'string' ? config[field].trim() : '');
  const configured = PROVIDER_ORDER.filter((id) => keyOf(SEARCH_PROVIDERS[id].keyField));
  const choice = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'auto';

  if (choice !== 'auto') {
    const provider = SEARCH_PROVIDERS[choice];
    if (!provider) {
      return { message: `WebSearch provider "${choice}" is unknown — set it to Tavily or Serper in the web plugin settings.` };
    }
    const apiKey = keyOf(provider.keyField);
    if (apiKey) return { id: choice, provider, apiKey };
    const other = configured[0];
    const hint = other
      ? ` (a ${SEARCH_PROVIDERS[other].label} key is configured — either switch the provider or add the ${provider.label} key)`
      : '';
    return { message: `WebSearch is set to ${provider.label} but no ${provider.label} API key is set in the web plugin settings${hint}.` };
  }

  const id = configured[0];
  if (!id) {
    return { message: 'WebSearch is not configured (no Tavily or Serper API key set in the web plugin settings). Use WebFetch with a known URL instead.' };
  }
  return { id, provider: SEARCH_PROVIDERS[id], apiKey: keyOf(SEARCH_PROVIDERS[id].keyField) };
}

export function register(ctx) {
  const maxResults = Number(ctx.config.maxResults) >= 1 ? Math.min(Number(ctx.config.maxResults), 10) : 5;

  ctx.registerTool(defineTool({
    name: 'WebSearch', label: 'Web search',
    description: 'Search the web and get titles, URLs and content snippets. For recent software, documentation or events, include the current year in the query. Results are short snippets — follow up with WebFetch on the most relevant URL when you need the full page, and cite the URLs you used in your reply.',
    parameters: Type.Object({ query: Type.String({ description: 'Search query' }) }),
    execute: async (_id, p) => {
      const selected = resolveSearchProvider(ctx.config);
      if (selected.message) return ok(selected.message);
      try {
        const { answer, results } = await selected.provider.search(selected.apiKey, p.query, maxResults);
        const lines = [];
        if (answer) lines.push(`Answer: ${answer}`, '');
        for (const r of results) lines.push(`- ${r.title}\n  ${r.url}\n  ${String(r.snippet ?? '').slice(0, SNIPPET_CHARS)}`);
        return ok(lines.join('\n') || 'No results.');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WebFetch', label: 'Fetch web page',
    description: 'Fetch a public http(s) URL and return its readable text content: HTML is stripped to text, redirects are followed, and the output is truncated at 20k characters. Read-only; private and loopback URLs are refused. Pages rendered entirely in JavaScript may return little or nothing — prefer an API or feed URL when one exists.',
    parameters: Type.Object({ url: Type.String({ description: 'Absolute http(s) URL' }) }),
    execute: async (_id, p) => {
      try {
        const res = await fetchGuarded(p.url, {
          headers: { 'user-agent': 'orca-brain/1.0 (+web plugin)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') ?? '';
        const body = await res.text();
        const text = type.includes('html') ? htmlToText(body) : body;
        return ok(text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n…[truncated]` : text);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info('web tools registered (search + fetch)');
}
