import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The plugin is plain ESM shipped as-is into dist/plugins, so the test drives the REAL entry file
// rather than a TypeScript re-implementation of it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginEntry = pathToFileURL(join(repoRoot, 'plugins/web/index.mjs')).href;

interface Tool { name: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }
interface Captured { url: string; init: RequestInit & { headers: Record<string, string> } }

/** Register the plugin with a config and capture what WebSearch puts on the wire. */
async function mount(config: Record<string, unknown>, body?: unknown) {
  const { register } = await import(pluginEntry) as { register: (ctx: unknown) => void };
  const tools: Tool[] = [];
  register({ config, logger: { info() {} }, registerTool: (tool: Tool) => tools.push(tool) });
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Captured['init'] });
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const search = tools.find((t) => t.name === 'WebSearch');
  expect(search, 'WebSearch must be registered').toBeTruthy();
  return { search: search!, calls };
}

const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;

const SERPER_BODY = {
  answerBox: { answer: '42' },
  organic: [{ title: 'First hit', link: 'https://example.com/a', snippet: 'Alpha snippet' }],
};

describe('web plugin WebSearch backends', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a Serper search to serper.dev with the key header and normalizes the answer box', async () => {
    const { search, calls } = await mount({ provider: 'serper', serperApiKey: 'serper-key', maxResults: 2 }, SERPER_BODY);

    const text = textOf(await search.execute('t', { query: 'meaning of life' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://google.serper.dev/search');
    expect(calls[0]!.init.headers['x-api-key']).toBe('serper-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ q: 'meaning of life', num: 2 });
    // Identical shape to Tavily's output, so the brain reads one format whichever backend answered.
    expect(text).toMatch(/^Answer: 42\n\n- First hit\n {2}https:\/\/example\.com\/a\n {2}Alpha snippet$/);
  });

  it('keeps a legacy Tavily-only install on Tavily', async () => {
    const { search, calls } = await mount(
      { tavilyApiKey: 'tavily-key', maxResults: 3 },
      { answer: 'Tavily answer', results: [{ title: 'T', url: 'https://t.example', content: 'Tavily snippet' }] },
    );

    const text = textOf(await search.execute('t', { query: 'anything' }));

    expect(calls[0]!.url).toBe('https://api.tavily.com/search');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ api_key: 'tavily-key', query: 'anything', max_results: 3, include_answer: true });
    expect(text).toMatch(/^Answer: Tavily answer\n\n- T\n {2}https:\/\/t\.example\n {2}Tavily snippet$/);
  });

  it('picks Serper automatically when it is the only key configured', async () => {
    const { search, calls } = await mount({ serperApiKey: 'serper-key' }, SERPER_BODY);
    await search.execute('t', { query: 'q' });
    expect(calls[0]!.url).toBe('https://google.serper.dev/search');
  });

  it('explains a provider selected without its key instead of calling out', async () => {
    const { search, calls } = await mount({ provider: 'serper', tavilyApiKey: 'tavily-key' });

    const text = textOf(await search.execute('t', { query: 'q' }));

    expect(calls).toHaveLength(0);
    expect(text).toMatch(/set to Serper but no Serper API key/);
    expect(text).toMatch(/a Tavily key is configured/);
  });

  it('keeps the WebFetch-only guidance when no key is set at all', async () => {
    const { search, calls } = await mount({});
    expect(textOf(await search.execute('t', { query: 'q' }))).toMatch(/not configured .*no Tavily or Serper API key/);
    expect(calls).toHaveLength(0);
  });
});
