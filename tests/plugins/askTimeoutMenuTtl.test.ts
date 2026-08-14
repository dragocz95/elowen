import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A numbered WhatsApp menu is the same thing as a parked AskUserQuestion: an interactive prompt this
// chat still owes an answer to. It used to expire on its own hardcoded six minutes while `askTimeoutMs`
// governed only the ask, so raising the setting left the menu dying at the old bound. These tests pin
// the menu to that ONE setting. (The Telegram picker half moved to the plugin registry with its plugin.)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const CHAT = '420123456789@s.whatsapp.net';

const advance = (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };

// Only Date is faked — the adapter stamps `createdAt` with Date.now() and compare against it, while the
// command handlers themselves run on real promises.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-14T09:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

interface ModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  reasoningLevels?: string[];
  reasoningLabels?: Record<string, string>;
}

interface WhatsAppAdapterUnderTest {
  pendingMenus: Map<string, unknown>;
  sendText(jid: string, text: string): Promise<void>;
  handleCommand(chatJid: string, senderJid: string, text: string): Promise<boolean>;
  handleTextReply(chatJid: string, senderJid: string, text: string, message: unknown): Promise<boolean>;
}

const REASONING_MODEL: ModelOption = {
  provider: 'openai', providerLabel: 'OpenAI OAuth', model: 'gpt-5.4',
  reasoningLevels: ['low', 'xhigh'], reasoningLabels: { low: 'low', xhigh: 'ultra' },
};

const makeWhatsApp = async (cfg: Record<string, unknown>) => {
  const { WhatsAppAdapter } = await import(join(repoRoot, 'plugins/whatsapp/lib/adapter.mjs')) as {
    WhatsAppAdapter: new (...args: unknown[]) => WhatsAppAdapterUnderTest;
  };
  const chats: Record<string, Record<string, unknown>> = {
    [CHAT]: { model: { provider: 'openai', model: 'gpt-5.4' } },
  };
  const state = {
    get: (id: string) => chats[id] ?? {},
    patch: (id: string, fields: Record<string, unknown>) => { chats[id] = { ...(chats[id] ?? {}), ...fields }; },
  };
  const adapter = new WhatsAppAdapter(
    { language: 'en', senderPolicies: [{ roleId: CHAT, admin: true }], ...cfg },
    log, state, async () => [REASONING_MODEL], [], '', '', () => false, () => [],
  );
  const sent: string[] = [];
  adapter.sendText = async (_jid: string, text: string) => { sent.push(text); };
  return { adapter, chats, sent };
};

describe('whatsapp numbered menu honours askTimeoutMs', () => {
  it('a menu is still answerable ten minutes on when askTimeoutMs was raised', async () => {
    const { adapter, chats } = await makeWhatsApp({ askTimeoutMs: 1_800_000 }); // 30 min
    expect(await adapter.handleCommand(CHAT, CHAT, '/reasoning')).toBe(true);

    advance(10 * 60_000); // past the old hardcoded six-minute menu TTL
    expect(await adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(true);
    expect(chats[CHAT]?.thinkingLevel).toBe('xhigh');
  });

  it('a menu expires early when askTimeoutMs was LOWERED', async () => {
    const { adapter, chats } = await makeWhatsApp({ askTimeoutMs: 60_000 }); // 1 min
    await adapter.handleCommand(CHAT, CHAT, '/reasoning');

    advance(2 * 60_000);
    // Not consumed: the reply falls through to a normal brain turn, and the stale menu is dropped.
    expect(await adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(false);
    expect(adapter.pendingMenus.has(CHAT)).toBe(false);
    expect(chats[CHAT]?.thinkingLevel).toBeUndefined();
  });

  it('unset askTimeoutMs keeps the six-minute default on both sides of the boundary', async () => {
    const inside = await makeWhatsApp({});
    await inside.adapter.handleCommand(CHAT, CHAT, '/reasoning');
    advance(5 * 60_000);
    expect(await inside.adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(true);

    const outside = await makeWhatsApp({});
    await outside.adapter.handleCommand(CHAT, CHAT, '/reasoning');
    advance(7 * 60_000);
    expect(await outside.adapter.handleTextReply(CHAT, CHAT, '3', {})).toBe(false);
  });
});
