import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

describe('web plugin', () => {
  it('registers web_search + web_fetch', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search']);
  });

  it('web_search without an API key returns a helpful message instead of failing', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    const tool = reg.tools.find((t) => t.name === 'web_search')!;
    const res = await tool.execute('t1', { query: 'orca' }, undefined as never, undefined as never);
    expect((res.content[0] as { text: string }).text).toMatch(/not configured/);
  });

  it('web_fetch refuses private addresses and non-http schemes', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    const tool = reg.tools.find((t) => t.name === 'web_fetch')!;
    for (const url of ['http://127.0.0.1/x', 'http://localhost/x', 'file:///etc/passwd', 'http://192.168.1.1/']) {
      const res = await tool.execute('t1', { url }, undefined as never, undefined as never);
      expect((res.content[0] as { text: string }).text).toMatch(/Error/);
    }
  });

  it('web_fetch refuses IPv4-mapped IPv6 loopback literals', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    const tool = reg.tools.find((t) => t.name === 'web_fetch')!;
    const res = await tool.execute('t1', { url: 'http://[::ffff:127.0.0.1]/x' }, undefined as never, undefined as never);
    expect((res.content[0] as { text: string }).text).toMatch(/Error/);
  });

  it('web_fetch does NOT follow a redirect that points at a private address (SSRF via 302)', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    const tool = reg.tools.find((t) => t.name === 'web_fetch')!;
    const origFetch = globalThis.fetch;
    let hops = 0;
    // Public IP literal (no DNS) that 302s to the daemon's loopback API.
    globalThis.fetch = (async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4400/admin' } });
    }) as typeof fetch;
    try {
      const res = await tool.execute('t1', { url: 'http://8.8.8.8/start' }, undefined as never, undefined as never);
      expect((res.content[0] as { text: string }).text).toMatch(/private address/);
      expect(hops).toBe(1); // stopped after the first hop; never fetched the loopback target
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('web_fetch follows a redirect to another PUBLIC url and returns its body', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['web'], logger: log });
    const tool = reg.tools.find((t) => t.name === 'web_fetch')!;
    const origFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      if (seen.length === 1) return new Response(null, { status: 301, headers: { location: 'http://1.1.1.1/final' } });
      return new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    try {
      const res = await tool.execute('t1', { url: 'http://8.8.8.8/start' }, undefined as never, undefined as never);
      expect((res.content[0] as { text: string }).text).toContain('hello world');
      expect(seen).toEqual(['http://8.8.8.8/start', 'http://1.1.1.1/final']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('htmlToText strips markup, scripts and entities', async () => {
    const { htmlToText } = await import(join(pluginsDir, 'web/index.mjs')) as { htmlToText: (h: string) => string };
    const text = htmlToText('<head><title>x</title></head><body><script>evil()</script><h1>Ahoj &amp; vítej</h1><p>Řádek</p></body>');
    expect(text).toContain('Ahoj & vítej');
    expect(text).toContain('Řádek');
    expect(text).not.toContain('evil');
  });
});

describe('memory plugin', () => {
  it('skips tool registration without an endpoint', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['memory'], logger: log });
    expect(reg.tools).toHaveLength(0);
  });

  it('registers add_memory + search_memory with an endpoint and calls mem0 with x-api-key auth', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.['x-api-key'] ?? null });
      return new Response(JSON.stringify({ results: [{ memory: 'Filip má rád teal.' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const reg = await loadPlugins({
        dirs: [pluginsDir], enabled: ['memory'], logger: log,
        config: { memory: { endpoint: 'http://127.0.0.1:3401/', apiKey: 'k', userId: 'orca' } },
      });
      expect(reg.tools.map((t) => t.name).sort()).toEqual(['add_memory', 'search_memory']);
      const search = reg.tools.find((t) => t.name === 'search_memory')!;
      const res = await search.execute('t1', { query: 'barva' }, undefined as never, undefined as never);
      expect((res.content[0] as { text: string }).text).toContain('Filip má rád teal.');
      expect(calls[0]!.url).toBe('http://127.0.0.1:3401/search'); // trailing slash normalized
      expect(calls[0]!.auth).toBe('k');
      const add = reg.tools.find((t) => t.name === 'add_memory')!;
      await add.execute('t2', { text: 'fakt' }, undefined as never, undefined as never);
      expect(calls[1]!.url).toBe('http://127.0.0.1:3401/memories');
      expect((calls[1]!.body as { user_id: string }).user_id).toBe('orca');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('keys the memory on the turn identity: owner → config id, non-owner linked → namespaced username, unknown → platform id', async () => {
    const calls: { body: { user_id: string } }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as { user_id: string } });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const reg = await loadPlugins({
        dirs: [pluginsDir], enabled: ['memory'], logger: log,
        config: { memory: { endpoint: 'http://127.0.0.1:3401', userId: 'alex' } },
      });
      const add = reg.tools.find((t) => t.name === 'add_memory')!;
      const userPolicy = { allowedProjectIds: new Set<number>(), allowedPaths: () => [] };
      // OWNER turn → the configured owner id (continuity with a pre-Orca memory store).
      await runWithPolicy({ allowedProjectIds: 'all', allowedPaths: () => [] },
        () => add.execute('t1', { text: 'f' }, undefined as never, undefined as never),
        { platform: 'discord', userId: '999', orcaUsername: 'admin', admin: true, owner: true });
      // Admin-but-NOT-owner (foreign member with an admin role) must NOT reach the owner store — they
      // get their own namespaced key, never the bare owner id.
      await runWithPolicy({ allowedProjectIds: 'all', allowedPaths: () => [] },
        () => add.execute('t2', { text: 'f' }, undefined as never, undefined as never),
        { platform: 'discord', userId: '111', orcaUsername: 'amy', admin: true, owner: false });
      // Unknown platform sender → stable platform-scoped key.
      await runWithPolicy(userPolicy,
        () => add.execute('t3', { text: 'f' }, undefined as never, undefined as never),
        { platform: 'discord', userId: '222', admin: false, owner: false });
      expect(calls.map((c) => c.body.user_id)).toEqual(['alex', 'orca:amy', 'discord:222']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
