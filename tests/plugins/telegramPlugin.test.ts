import { describe, it, expect, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('telegram plugin', () => {
  it('registers no platform without a botToken (warns instead of crashing)', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['telegram'], logger: log });
    expect(reg.platforms).toHaveLength(0);
  });

  it('registers the platform adapter when a botToken is configured', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['telegram'], logger: log,
      config: { telegram: { botToken: 'tok', rolePolicies: [] } },
    });
    expect(reg.platforms.map((p) => p.name)).toEqual(['telegram']);
  });

  it('declares every registered tool in its manifest (registry refuses undeclared tools)', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['telegram'], logger: log,
      config: { telegram: { botToken: 'tok', rolePolicies: [] } },
    });
    const names = reg.tools.map((t) => t.name).filter((n) => n.startsWith('Telegram'));
    expect(names).toContain('TelegramSend');
    expect(names).toContain('TelegramApi');
    expect(names).toContain('TelegramCreateForumTopic');
    expect(names.length).toBe(16);
  });
});

describe('telegram splitContent (code-block-aware chunking)', () => {
  it('never breaks a fenced code block across a chunk boundary', async () => {
    const { splitContent } = await import(join(repoRoot, 'plugins/telegram/index.mjs')) as { splitContent: (t: string) => string[] };
    const big = '```js\n' + 'const x = 1;\n'.repeat(500) + '```'; // > 4000 chars, one fence
    const pieces = splitContent(big);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(4100);
      expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0); // every piece has balanced fences
    }
    expect(pieces.join('')).toContain('const x = 1;');
  });

  it('leaves short text untouched', async () => {
    const { splitContent } = await import(join(repoRoot, 'plugins/telegram/index.mjs')) as { splitContent: (t: string) => string[] };
    expect(splitContent('ahoj')).toEqual(['ahoj']);
  });
});

describe('telegram buildAskKeyboard (inline keyboard)', () => {
  it('single-select single-question ask needs no Submit (a click answers instantly)', async () => {
    const { buildAskKeyboard } = await import(join(repoRoot, 'plugins/telegram/index.mjs')) as {
      buildAskKeyboard: (token: string, qs: unknown[], opts?: unknown) => { text: string; callback_data: string }[][];
    };
    const rows = buildAskKeyboard('t', [{ header: 'Pick', question: 'q', options: [{ label: 'A' }, { label: 'B' }] }]);
    const flat = rows.flat().map((b) => b.callback_data);
    expect(flat).toContain('a:t:0:0');
    expect(flat).toContain('a:t:0:1');
    expect(flat.some((d) => d.endsWith(':submit'))).toBe(false); // a single-select click answers instantly
    expect(flat.some((d) => d.endsWith(':other'))).toBe(true); // free-text Other on a single-question ask
  });

  it('a multiSelect ask carries a Submit button and no instant Other', async () => {
    const { buildAskKeyboard } = await import(join(repoRoot, 'plugins/telegram/index.mjs')) as {
      buildAskKeyboard: (token: string, qs: unknown[], opts?: unknown) => { text: string; callback_data: string }[][];
    };
    const rows = buildAskKeyboard('t', [{ header: 'Pick', question: 'q', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]);
    const flat = rows.flat().map((b) => b.callback_data);
    expect(flat.some((d) => d.endsWith(':submit'))).toBe(true);
  });
});

describe('telegram identity matching (rolePolicies)', () => {
  it('matches a Telegram user id, @username (case-insensitive) and chat id', async () => {
    const { matchesId, senderIds, senderIsAdmin } = await import(join(repoRoot, 'plugins/telegram/index.mjs')) as {
      matchesId: (a: string, b: string) => boolean;
      senderIds: (from: { id: number; username?: string }, chatId: number) => string[];
      senderIsAdmin: (ids: string[], policies: unknown[]) => boolean;
    };
    expect(matchesId('123456789', '123456789')).toBe(true);
    expect(matchesId('@Alice', '@alice')).toBe(true);
    expect(matchesId('@alice', 'alice')).toBe(true);
    expect(matchesId('123', '456')).toBe(false);
    const ids = senderIds({ id: 42, username: 'bob' }, -1001);
    expect(ids).toEqual(['42', '@bob', '-1001']);
    expect(senderIsAdmin(ids, [{ roleId: '@bob', admin: true }])).toBe(true);
    expect(senderIsAdmin(ids, [{ roleId: '@bob' }])).toBe(false); // not flagged admin
    expect(senderIsAdmin(ids, [{ roleId: '-1001', admin: true }])).toBe(true); // whole-chat admin policy
  });
});

describe('telegram paged pickers + /context', () => {
  const makeAdapter = async (models: unknown[], initial: Record<string, unknown> = {}) => {
    const { TelegramAdapter } = await import(join(repoRoot, 'plugins/telegram/lib/adapter.mjs')) as { TelegramAdapter: new (...args: unknown[]) => any };
    const chats: Record<string, Record<string, unknown>> = { '5': initial };
    const state = {
      get: (id: string) => chats[id] ?? {},
      patch: (id: string, fields: Record<string, unknown>) => { chats[id] = { ...(chats[id] ?? {}), ...fields }; },
    };
    const adapter = new TelegramAdapter(
      { language: 'en', rolePolicies: [{ roleId: '42', admin: true }] },
      log, state, async () => models,
    );
    const sent: { text: string; extra: any }[] = [];
    const edits: { text: string; extra: any }[] = [];
    const markups: any[] = [];
    adapter.tgSend = async (_chatId: number, text: string, extra: any = {}) => { sent.push({ text, extra }); return 111; };
    adapter.tgEdit = async (_chatId: number, _mid: number, text: string, extra: any = {}) => { edits.push({ text, extra }); return true; };
    adapter.bot = { api: { editMessageReplyMarkup: async (_c: number, _mid: number, other: any) => { markups.push(other); } } };
    return { adapter, chats, sent, edits, markups };
  };
  // A callback_query ctx for onCallback (admin sender id 42).
  const cbCtx = (data: string, fromId = 42) => ({
    callbackQuery: { data, from: { id: fromId }, message: { chat: { id: 5 }, message_id: 111 } },
    answerCallbackQuery: async () => {},
  });
  const adminIds = ['42'];

  const models20 = Array.from({ length: 20 }, (_, i) => ({ provider: 'p', providerLabel: 'Prov', model: `model-${i}` }));

  it('publishes /context in the command menu', async () => {
    const { adapter } = await makeAdapter([]);
    let published: any[] = [];
    adapter.bot = { api: { setMyCommands: async (cmds: any[]) => { published = cmds; } } };
    await adapter.publishCommands();
    expect(published.find((c) => c.command === 'context')).toBeTruthy();
  });

  it('/model pages the FULL catalog (no .slice(0,40) truncation) and picks a model from a later page', async () => {
    const { adapter, chats, sent, markups } = await makeAdapter(models20);
    await adapter.handleCommand(5, { id: 42 }, adminIds, '/model');
    const kb0 = sent[0].extra.reply_markup.inline_keyboard;
    expect(kb0).toHaveLength(9); // 8 model rows + 1 nav row (PICKER_PAGE = 8)
    expect(adapter.pendingPickers.get('5').models).toHaveLength(20); // full list cached, nothing dropped
    // Navigate to page 1 → the keyboard redraws in place (no re-fetch).
    await adapter.onCallback(cbCtx('m_page:1'));
    const kb1 = markups[0].reply_markup.inline_keyboard;
    expect(kb1[0][0].callback_data).toBe('m:8'); // absolute indices continue past the first page
    // Pick model-12 (index 12, only reachable because the list is no longer truncated).
    await adapter.onCallback(cbCtx('m:12'));
    expect(chats['5']?.model).toEqual({ provider: 'p', model: 'model-12' });
  });

  it('/context lists the caller\'s own conversations and binds the pick with a privacy warning', async () => {
    const { adapter, sent, edits } = await makeAdapter([]);
    const listContext = vi.fn(() => ({ items: [{ id: 'brain-7-1', title: 'Refactor', model: 'gpt-5' }], total: 1, hasMore: false }));
    const bindContext = vi.fn(async () => ({ title: 'Refactor' }));
    adapter.control({ listContext, bindContext });
    await adapter.handleCommand(5, { id: 42 }, adminIds, '/context');
    expect(listContext).toHaveBeenCalledWith({ platform: 'telegram', channelId: '5#0' }, '42', { offset: 0, limit: 200 });
    expect(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data).toBe('c:0');
    await adapter.onCallback(cbCtx('c:0'));
    expect(bindContext).toHaveBeenCalledWith({ platform: 'telegram', channelId: '5#0' }, '42', 'brain-7-1');
    expect(edits.at(-1)!.text).toContain('Refactor');
    expect(edits.at(-1)!.text).toContain('continues');
  });

  it('/context is operator-gated (a non-admin sender is refused)', async () => {
    const { adapter, sent } = await makeAdapter([]);
    const listContext = vi.fn();
    adapter.control({ listContext, bindContext: vi.fn() });
    await adapter.handleCommand(5, { id: 999 }, ['999'], '/context');
    expect(listContext).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text).toContain('Only the operator');
  });
});
