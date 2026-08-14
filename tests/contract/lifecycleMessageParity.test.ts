import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lifecycleNotice, LIFECYCLE_KEYS, type LifecycleKey } from '../../src/daemon/lifecycleNotices.js';

// The daemon words its own lifecycle announcements (stopping, back online, restart) and sends them as
// English text plus a descriptor naming which one it is. Adapters translate from the descriptor, using
// the text as the fallback — so the English entry in the plugin table is a MIRROR of the daemon's
// wording, not a second source of truth. Nothing links the two: the untyped `.mjs` plugin library cannot
// import the daemon's NodeNext source, exactly as with `stripThinking` next door.
//
// Left unguarded, the two copies drift the moment someone rewords one side, and the result is invisible:
// an English instance keeps reading fine (it is served the daemon's fallback) while a Czech one silently
// says something the daemon no longer says. This test is the link.
//
// This lock works by reading the shared source from disk, so it holds only while elowen-plugin-shared
// is built from this repository. If that package is ever developed elsewhere, the guard has to become
// something the package itself carries (a published fixture both sides assert against) — otherwise it
// keeps passing against a copy nobody ships.
const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/plugin-shared/lifecycle.mjs');
const plugin = await import(pluginPath) as {
  LIFECYCLE_MESSAGES: Record<string, Record<string, string | ((...a: never[]) => string)>>;
  lifecycleText(lang: string, notice: unknown, fallback: string): string;
};

/** Arguments per key, so both halves can be rendered and compared as finished strings. */
const CASES: { key: LifecycleKey; args: (string | number)[] }[] = [
  { key: 'stopping', args: [3, 2, 1] },
  { key: 'stoppingIdle', args: [] },
  { key: 'backOnline', args: [] },
  { key: 'backOnlineVersion', args: ['0.27.80'] },
  { key: 'restarting', args: [] },
  { key: 'restartFailed', args: [] },
];

const render = (table: Record<string, string | ((...a: never[]) => string)>, key: string, args: (string | number)[]) => {
  const entry = table[key];
  return typeof entry === 'function' ? (entry as (...a: unknown[]) => string)(...args) : entry;
};

describe('lifecycle notice parity (daemon ↔ plugin adapters)', () => {
  it('covers every key the daemon can send', () => {
    expect(CASES.map((c) => c.key).sort()).toEqual([...LIFECYCLE_KEYS].sort());
  });

  it.each(CASES)('English matches the daemon wording for $key', ({ key, args }) => {
    const fromDaemon = lifecycleNotice(key, ...(args as [never])).text;
    expect(render(plugin.LIFECYCLE_MESSAGES.en, key, args)).toBe(fromDaemon);
  });

  it.each(['cs', 'sk'])('%s translates every key', (lang) => {
    for (const { key, args } of CASES) {
      const translated = render(plugin.LIFECYCLE_MESSAGES[lang], key, args);
      expect(translated, `${lang}.${key} is missing`).toBeTruthy();
      expect(translated).not.toBe(render(plugin.LIFECYCLE_MESSAGES.en, key, args));
    }
  });

  // The counts are what the user reads to decide whether to wait, so a translation that drops one is
  // worse than no translation at all.
  it.each(['en', 'cs', 'sk'])('%s keeps all three counts in the stopping notice', (lang) => {
    const text = render(plugin.LIFECYCLE_MESSAGES[lang], 'stopping', [7, 5, 3]);
    expect(text).toContain('7');
    expect(text).toContain('5');
    expect(text).toContain('3');
  });
});

describe('lifecycleText', () => {
  const notice = { key: 'stoppingIdle' as const };

  it('renders the configured language', () => {
    expect(plugin.lifecycleText('cs', notice, 'FALLBACK')).toBe('🛑 **Zastavuji** — Elowen se vypíná.');
  });

  it('falls back to the supplied text for free-form notifications', () => {
    expect(plugin.lifecycleText('cs', undefined, 'cron said hello')).toBe('cron said hello');
  });

  it('falls back for a language it has no table for', () => {
    expect(plugin.lifecycleText('de', notice, 'FALLBACK')).toBe('FALLBACK');
  });

  it('falls back for a key from a newer daemon', () => {
    expect(plugin.lifecycleText('cs', { key: 'somethingAddedLater' }, 'FALLBACK')).toBe('FALLBACK');
  });

  it('interpolates the arguments in order', () => {
    const text = plugin.lifecycleText('cs', { key: 'stopping', args: [9, 8, 7] }, 'FALLBACK');
    expect(text).toContain('9');
    expect(text).toContain('8');
    expect(text).toContain('7');
  });
});
