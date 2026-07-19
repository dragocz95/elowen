import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const log = { info() {}, warn() {}, error() {} };
const CHAT = '420123456789@s.whatsapp.net';

interface ModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  reasoningLevels?: string[];
  reasoningLabels?: Record<string, string>;
  fastAvailable?: boolean;
  default?: boolean;
}

interface TestAdapter {
  pendingMenus: Map<string, unknown>;
  control(api: {
    status?: (ref: unknown) => { provider?: string; model: string } | null;
    setFast?: (ref: unknown, on?: boolean) => { fast: boolean; fastAvailable: boolean } | null;
    listContext?: (ref: unknown, sender: string, opts: unknown) => { items: { id: string; title: string; model: string }[]; total: number; hasMore: boolean } | null;
    bindContext?: (ref: unknown, sender: string, sessionId: string) => Promise<{ title: string }>;
  }): void;
  handleCommand(chatJid: string, senderJid: string, text: string): Promise<boolean>;
  handleTextReply(chatJid: string, senderJid: string, text: string, message: unknown): Promise<boolean>;
}

const makeAdapter = async (models: ModelOption[], initial: Record<string, unknown> = {}, language = 'en', commands = [{ name: 'fast' }]) => {
  const { WhatsAppAdapter } = await import(join(repoRoot, 'plugins/whatsapp/lib/adapter.mjs')) as {
    WhatsAppAdapter: new (...args: unknown[]) => TestAdapter & { sendText: (jid: string, text: string) => Promise<void> };
  };
  const chats: Record<string, Record<string, unknown>> = { [CHAT]: initial };
  const state = {
    get: (id: string) => chats[id] ?? {},
    patch: (id: string, fields: Record<string, unknown>) => { chats[id] = { ...(chats[id] ?? {}), ...fields }; },
  };
  const adapter = new WhatsAppAdapter(
    { language, senderPolicies: [{ roleId: CHAT, admin: true }] },
    log, state, async () => models, [], '', '', () => false, commands,
  );
  const sent: string[] = [];
  adapter.sendText = async (_jid: string, text: string) => { sent.push(text); };
  return { adapter, chats, sent };
};

describe('whatsapp reasoning command capabilities', () => {
  it('builds the numbered menu only from the selected model and displays max/ultra labels', async () => {
    const models: ModelOption[] = [
      { provider: 'plain', providerLabel: 'Plain', model: 'chat-only' },
      {
        provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4',
        reasoningLevels: ['low', 'xhigh'], reasoningLabels: { low: 'low', xhigh: 'ultra' },
      },
      {
        provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4-8',
        reasoningLevels: ['minimal', 'high', 'xhigh'], reasoningLabels: { minimal: 'minimal', high: 'high', xhigh: 'max' },
      },
    ];
    const { adapter, chats, sent } = await makeAdapter(models, { model: { provider: 'openai', model: 'gpt-5.4' } });

    expect(await adapter.handleCommand(CHAT, CHAT, '/thinking')).toBe(true);
    expect(sent[0]).toContain('1. *default* — model default');
    expect(sent[0]).toContain('2. *low*');
    expect(sent[0]).toContain('3. *ultra*');
    expect(sent[0]).not.toContain('*minimal*');

    expect(await adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(true);
    expect(chats[CHAT]?.thinkingLevel).toBe('xhigh');
    expect(sent.at(-1)).toContain('Reasoning effort set to *ultra*');

    chats[CHAT] = { model: { provider: 'anthropic', model: 'claude-opus-4-8' } };
    await adapter.handleCommand(CHAT, CHAT, '/thinking');
    expect(sent.at(-1)).toContain('4. *max*');
    expect(sent.at(-1)).not.toContain('*ultra*');
  });

  it('gives a clear localized message for models without configurable reasoning', async () => {
    const models = [{ provider: 'plain', providerLabel: 'Plain', model: 'chat-only' }];
    for (const [language, expected] of [
      ['en', 'does not support configurable reasoning effort'],
      ['cs', 'nepodporuje nastavitelnou úroveň uvažování'],
    ] as const) {
      const { adapter, sent } = await makeAdapter(models, { model: { provider: 'plain', model: 'chat-only' } }, language);
      await adapter.handleCommand(CHAT, CHAT, '/thinking');
      expect(sent.at(-1)).toContain(expected);
      expect(adapter.pendingMenus.has(CHAT)).toBe(false);
    }
  });

  it('uses the daemon-resolved default model and localizes its default-level reply', async () => {
    const models: ModelOption[] = [
      { provider: 'plain', providerLabel: 'Plain', model: 'catalog-first' },
      { provider: 'openai', providerLabel: 'OAuth', model: 'actual-default', default: true, reasoningLevels: ['low'] },
    ];
    const { adapter, chats, sent } = await makeAdapter(models, {}, 'cs');
    await adapter.handleCommand(CHAT, CHAT, '/thinking');
    expect(sent.at(-1)).toContain('*low*');
    expect(sent.at(-1)).toContain('*výchozí*');

    expect(await adapter.handleTextReply(CHAT, CHAT, '1', {})).toBe(true);
    expect(chats[CHAT]?.thinkingLevel).toBe('');
    expect(sent.at(-1)).toContain('*výchozí*');
    expect(sent.at(-1)).not.toContain('*default*');
  });

  it('revalidates a numeric menu reply when model capabilities change', async () => {
    const models: ModelOption[] = [{
      provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4',
      reasoningLevels: ['low', 'xhigh'], reasoningLabels: { xhigh: 'ultra' },
    }];
    const { adapter, chats, sent } = await makeAdapter(models, {
      model: { provider: 'openai', model: 'gpt-5.4' }, thinkingLevel: 'low',
    });
    await adapter.handleCommand(CHAT, CHAT, '/thinking');
    models[0] = { provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4' };

    expect(await adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(true);
    expect(chats[CHAT]?.thinkingLevel).toBe('low');
    expect(sent.at(-1)).toContain('does not support configurable reasoning effort');
    expect(adapter.pendingMenus.has(CHAT)).toBe(false);
  });
});

describe('whatsapp /fast capability gate', () => {
  it('does not let a stale OAuth live session enable fast for a selected non-OAuth model', async () => {
    const models = [{ provider: 'plain', providerLabel: 'Plain', model: 'chat-only' }];
    const { adapter, chats, sent } = await makeAdapter(models, { model: { provider: 'plain', model: 'chat-only' }, fast: false });
    const setFast = vi.fn(() => ({ fast: true, fastAvailable: true }));
    adapter.control({
      status: () => ({ provider: 'openai', model: 'gpt-5.4' }),
      setFast,
    });

    expect(await adapter.handleCommand(CHAT, CHAT, '/fast')).toBe(true);
    expect(setFast).not.toHaveBeenCalled();
    expect(chats[CHAT]?.fast).toBe(false);
    expect(sent.at(-1)).toContain('available only with an OpenAI OAuth model');
  });

  it('persists Fast for a newly selected OAuth model without consulting a stale non-OAuth live session', async () => {
    const models: ModelOption[] = [{ provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4', fastAvailable: true }];
    const { adapter, chats } = await makeAdapter(models, { model: { provider: 'openai', model: 'gpt-5.4' }, fast: false });
    const setFast = vi.fn(() => ({ fast: false, fastAvailable: false }));
    adapter.control({ status: () => ({ provider: 'plain', model: 'chat-only' }), setFast });

    await adapter.handleCommand(CHAT, CHAT, '/fast on');

    expect(setFast).not.toHaveBeenCalled();
    expect(chats[CHAT]?.fast).toBe(true);
  });

  it('toggles fast for a capability-advertised OAuth model and allows clearing stale state elsewhere', async () => {
    const models: ModelOption[] = [
      { provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4', fastAvailable: true },
      { provider: 'plain', providerLabel: 'Plain', model: 'chat-only' },
    ];
    const { adapter, chats, sent } = await makeAdapter(models, { model: { provider: 'openai', model: 'gpt-5.4' }, fast: false });
    const setFast = vi.fn((_ref: unknown, on?: boolean) => ({ fast: on === true, fastAvailable: true }));
    adapter.control({ status: () => ({ provider: 'openai', model: 'gpt-5.4' }), setFast });

    await adapter.handleCommand(CHAT, CHAT, '/fast on');
    expect(setFast).toHaveBeenCalledWith({ platform: 'whatsapp', channelId: `${CHAT}#0` }, true);
    expect(chats[CHAT]?.fast).toBe(true);
    expect(sent.at(-1)).toContain('Fast mode is *on*');

    chats[CHAT] = { model: { provider: 'plain', model: 'chat-only' }, fast: true };
    setFast.mockClear();
    await adapter.handleCommand(CHAT, CHAT, '/fast off');
    expect(setFast).not.toHaveBeenCalled();
    expect(chats[CHAT]?.fast).toBe(false);
    expect(sent.at(-1)).toContain('Fast mode is *off*');
  });

  it('clears fast when the model picker moves the chat away from OpenAI OAuth', async () => {
    const models: ModelOption[] = [
      { provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4', fastAvailable: true },
      { provider: 'plain', providerLabel: 'Plain', model: 'chat-only' },
    ];
    const { adapter, chats } = await makeAdapter(models, { model: { provider: 'openai', model: 'gpt-5.4' }, fast: true });
    await adapter.handleCommand(CHAT, CHAT, '/model');
    expect(await adapter.handleTextReply(CHAT, CHAT, '2', {})).toBe(true);
    expect(chats[CHAT]).toMatchObject({ model: { provider: 'plain', model: 'chat-only' }, fast: false });
  });

  it('does not claim /fast when the shared WhatsApp command catalog omits it', async () => {
    const models = [{ provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4', fastAvailable: true }];
    const { adapter, sent } = await makeAdapter(models, { model: { provider: 'openai', model: 'gpt-5.4' } }, 'en', []);
    expect(await adapter.handleCommand(CHAT, CHAT, '/fast')).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('whatsapp paged menus + /context', () => {
  const models20 = Array.from({ length: 20 }, (_, i) => ({ provider: 'p', providerLabel: 'Prov', model: `model-${i}` }));

  it('/model pages the FULL catalog (no .slice(0,20) truncation) and picks a model from a later page', async () => {
    const { adapter, chats, sent } = await makeAdapter(models20);
    await adapter.handleCommand(CHAT, CHAT, '/model');
    // Page 1/2: 18 numbered models + a "Next page" nav entry (numbered 19) — nothing dropped.
    expect(sent[0]).toContain('(1/2)');
    expect(sent[0]).toContain('19. *➡️ Next page*');
    expect((adapter.pendingMenus.get(CHAT) as { options: unknown[] }).options).toHaveLength(20);
    // Selecting the nav entry re-renders page 2.
    expect(await adapter.handleTextReply(CHAT, CHAT, '19', {})).toBe(true);
    expect(sent.at(-1)).toContain('(2/2)');
    expect(sent.at(-1)).toContain('1. *model-18*');
    // Pick the first row of page 2 → model-18 (index 18), only reachable because the list is not truncated.
    expect(await adapter.handleTextReply(CHAT, CHAT, '1', {})).toBe(true);
    expect(chats[CHAT]).toMatchObject({ model: { provider: 'p', model: 'model-18' } });
  });

  it('/context lists the caller\'s own conversations and binds the pick with a privacy warning', async () => {
    const { adapter, sent } = await makeAdapter([]);
    const listContext = vi.fn(() => ({ items: [{ id: 'brain-7-1', title: 'Refactor', model: 'gpt-5' }], total: 1, hasMore: false }));
    const bindContext = vi.fn(async () => ({ title: 'Refactor' }));
    adapter.control({ listContext, bindContext });
    expect(await adapter.handleCommand(CHAT, CHAT, '/context')).toBe(true);
    expect(listContext).toHaveBeenCalledWith({ platform: 'whatsapp', channelId: `${CHAT}#0` }, CHAT, { offset: 0, limit: 200 });
    expect(sent.at(-1)).toContain('1. *Refactor*');
    expect(await adapter.handleTextReply(CHAT, CHAT, '1', {})).toBe(true);
    expect(bindContext).toHaveBeenCalledWith({ platform: 'whatsapp', channelId: `${CHAT}#0` }, CHAT, 'brain-7-1');
    expect(sent.at(-1)).toContain('Refactor');
    expect(sent.at(-1)).toContain('continues');
  });

  it('/context is operator-gated (a non-admin sender is refused)', async () => {
    const { adapter, sent } = await makeAdapter([]);
    const listContext = vi.fn();
    adapter.control({ listContext, bindContext: vi.fn() });
    expect(await adapter.handleCommand(CHAT, 'stranger@s.whatsapp.net', '/context')).toBe(true);
    expect(listContext).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('Only the operator');
  });
});
