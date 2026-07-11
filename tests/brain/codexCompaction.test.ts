import { describe, expect, it, vi } from 'vitest';
import type { compact } from '@earendil-works/pi-coding-agent';
import { compactCodexWithModelFallback } from '../../src/brain/session/codexCompaction.js';

const result = { summary: 'stable summary', firstKeptEntryId: 'keep', tokensBefore: 123 };

describe('Codex compaction model fallback', () => {
  it('retries a provider-internal model-not-found route with stable gpt-5.5', async () => {
    const primary = { provider: 'openai-codex', id: 'gpt-5.6-luna' };
    const fallback = { provider: 'openai-codex', id: 'gpt-5.5' };
    const compactFn = vi.fn(async (_preparation, model: { id: string }) => {
      if (model.id === primary.id) throw new Error('Codex error: Model not found gpt-5.6-luna-free-1p-codexswic-ev3');
      return result;
    }) as unknown as typeof compact;
    const registry = {
      find: vi.fn((_provider: string, id: string) => id === fallback.id ? fallback : undefined),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'oauth-token', headers: {}, env: {} })),
    };

    await expect(compactCodexWithModelFallback({
      model: primary as never, registry: registry as never, preparation: {} as never, compactFn,
    })).resolves.toEqual(result);
    expect(compactFn.mock.calls.map((call) => call[1].id)).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
  });

  it('does not hide unrelated summarization failures behind a model switch', async () => {
    const compactFn = vi.fn(async () => { throw new Error('quota exceeded'); }) as unknown as typeof compact;
    const registry = {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'oauth-token' })),
    };
    await expect(compactCodexWithModelFallback({
      model: { provider: 'openai-codex', id: 'gpt-5.6-luna' } as never,
      registry: registry as never, preparation: {} as never, compactFn,
    })).rejects.toThrow('quota exceeded');
    expect(compactFn).toHaveBeenCalledTimes(1);
  });
});
