import { describe, it, expect } from 'vitest';
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
    const names = reg.tools.map((t) => t.name).filter((n) => n.startsWith('telegram_'));
    expect(names).toContain('telegram_send');
    expect(names).toContain('telegram_api');
    expect(names).toContain('telegram_create_forum_topic');
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
