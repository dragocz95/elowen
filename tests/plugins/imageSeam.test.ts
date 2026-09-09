import { describe, it, expect } from 'vitest';
import { PluginRegistry, type PluginHostWiring } from '../../src/plugins/registry.js';
import type { PluginCapabilities } from '../../src/plugins/api.js';
import { ImageService, OPENAI_CODEX_IMAGE_MODELS } from '../../src/brain/imageService.js';
import type { BrainProviderEntry } from '../../src/brain/providers.js';

const noopLog = { info() {}, warn() {}, error() {} };

const ACCESS_TOKEN = 'sk-oauth-access-token-never-leaves-core';

const providers: Record<string, BrainProviderEntry> = {
  chatgpt: { id: 'chatgpt', label: 'ChatGPT account', type: 'oauth-openai-codex', baseUrl: '', models: [], apiKey: null },
  openai: { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], apiKey: 'sk-plain-api-key' },
};

const resolveProvider = (id: string) => {
  const p = providers[id];
  return p ? { id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey } : null;
};

/** One captured request, so a test can assert what actually went on the wire. */
interface Sent { url: string; headers: Record<string, string>; body: unknown }

function imageBackend(sent: Sent[], payload?: Record<string, unknown>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    sent.push({ url: String(input), headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    return new Response(JSON.stringify(payload ?? {
      created: 1_757_000_000,
      background: 'opaque',
      data: [{ b64_json: Buffer.from('PNG-BYTES').toString('base64') }],
      output_format: 'png',
      quality: 'low',
      size: '1024x1024',
      usage: { input_tokens: 11, output_tokens: 22, output_tokens_details: { image_tokens: 20 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function service(sent: Sent[], payload?: Record<string, unknown>) {
  return new ImageService({
    resolveProvider,
    credentials: {
      get: () => ({ type: 'oauth', access: ACCESS_TOKEN, refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acct-1' } as never),
      getApiKey: async () => ACCESS_TOKEN,
    },
    fetchImpl: imageBackend(sent, payload),
  });
}

const wire = (config: Record<string, unknown>, caps?: PluginCapabilities, host?: PluginHostWiring) =>
  new PluginRegistry().contextFor(
    'image-gen', config, noopLog, undefined, undefined, undefined, resolveProvider, caps, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, host,
  );

describe('the host image seam', () => {
  it('sends the Codex image headers and the JSON body for an OAuth ChatGPT account', async () => {
    const sent: Sent[] = [];
    const result = await service(sent).generate({
      providerId: 'chatgpt', model: 'gpt-image-2.5-sunburst', prompt: 'a blue owl', quality: 'low', size: '1024x1024',
    });

    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.headers['chatgpt-account-id']).toBe('acct-1');
    expect(call.headers.originator).toBe('codex_cli_rs');
    expect(call.headers['user-agent']).toMatch(/^codex_cli_rs\//);
    expect(call.headers['session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers['x-codex-image-turn-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.body).toEqual({ prompt: 'a blue owl', model: 'gpt-image-2.5-sunburst', n: 1, quality: 'low', size: '1024x1024' });

    expect(result.png.toString()).toBe('PNG-BYTES');
    expect(result.size).toBe('1024x1024');
    expect(result.quality).toBe('low');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22, imageTokens: 20 });
  });

  it('posts edits as data URLs to the same Codex base', async () => {
    const sent: Sent[] = [];
    await service(sent).edit({
      providerId: 'chatgpt', model: 'gpt-image-2.5-flare', prompt: 'make the sky orange',
      images: [{ bytes: Buffer.from('SOURCE'), mime: 'image/jpeg' }],
    });
    const [call] = sent;
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
    expect(call.body).toMatchObject({
      images: [{ image_url: `data:image/jpeg;base64,${Buffer.from('SOURCE').toString('base64')}` }],
      prompt: 'make the sky orange',
      model: 'gpt-image-2.5-flare',
    });
  });

  // The backend renders ANY model string, so a typo in the settings field would silently bill a
  // nonexistent model instead of failing — the catalog is the gate on our side.
  it('refuses a model that is not in the account image catalog', async () => {
    const sent: Sent[] = [];
    await expect(service(sent).generate({ providerId: 'chatgpt', model: 'gpt-image-9-bogus', prompt: 'x' }))
      .rejects.toThrow(/gpt-image-9-bogus/);
    expect(sent).toEqual([]);
    expect(OPENAI_CODEX_IMAGE_MODELS).toContain('gpt-image-2.5-sunburst');
    expect(OPENAI_CODEX_IMAGE_MODELS).toContain('gpt-image-2.5-flare');
  });

  it('reports the HTTP status and detail of a failed image request', async () => {
    const failing = new ImageService({
      resolveProvider,
      credentials: { get: () => undefined, getApiKey: async () => ACCESS_TOKEN },
      fetchImpl: (async () => new Response('{"error":{"message":"quota"}}', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(failing.generate({ providerId: 'openai', model: 'gpt-image-1', prompt: 'x' }))
      .rejects.toThrow(/429.*quota/s);
  });

  it('uses the provider API key and the configured base URL for a key provider', async () => {
    const sent: Sent[] = [];
    await service(sent).generate({ providerId: 'openai', model: 'gpt-image-1', prompt: 'x', size: '1536x1024' });
    const [call] = sent;
    expect(call.url).toBe('https://api.openai.com/v1/images/generations');
    expect(call.headers.authorization).toBe('Bearer sk-plain-api-key');
    expect(call.body).toEqual({ prompt: 'x', model: 'gpt-image-1', n: 1, size: '1536x1024' });
  });
});

describe('ctx.images', () => {
  it('never hands the plugin the account token — only the rendered PNG', async () => {
    const sent: Sent[] = [];
    const ctx = wire({ provider: 'chatgpt' }, undefined, { images: service(sent) });
    const out = await ctx.images.generate({ providerId: 'chatgpt', model: 'gpt-image-2.5-sunburst', prompt: 'a blue owl' });

    expect(out.png.toString()).toBe('PNG-BYTES');
    // The only credential seam a plugin has hands out no key for an OAuth account…
    expect(ctx.resolveProvider('chatgpt')?.apiKey).toBeNull();
    // …and nothing reachable from the result or the seam carries the token.
    expect(JSON.stringify(out)).not.toContain(ACCESS_TOKEN);
    expect(Object.keys(ctx.images).sort()).toEqual(['edit', 'generate']);
    expect(sent[0].headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('denies a provider id the plugin was not wired to and declares no capability for', async () => {
    const sent: Sent[] = [];
    const ctx = wire({ provider: 'openai' }, undefined, { images: service(sent) });
    await expect(ctx.images.generate({ providerId: 'chatgpt', model: 'gpt-image-2.5-sunburst', prompt: 'x' }))
      .rejects.toThrow(/chatgpt/);
    expect(sent).toEqual([]);
  });

  it('allows any provider id to a plugin declaring the providers read capability', async () => {
    const sent: Sent[] = [];
    const ctx = wire({}, { reads: ['providers'] }, { images: service(sent) });
    await ctx.images.generate({ providerId: 'chatgpt', model: 'gpt-image-2.5-flare', prompt: 'x' });
    expect(sent).toHaveLength(1);
  });

  it('rejects rather than pretending when the process wired no image host', async () => {
    const ctx = wire({ provider: 'chatgpt' }, undefined, {});
    await expect(ctx.images.generate({ providerId: 'chatgpt', model: 'gpt-image-2.5-flare', prompt: 'x' }))
      .rejects.toThrow(/not available/i);
  });
});
