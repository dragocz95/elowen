import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { SHARED_MESSAGES } from '../../plugins/_shared/messages.mjs';
// @ts-expect-error — plain .mjs plugin module, no types
import { renderHelpLines, HELP_DESCRIPTIONS } from '../../plugins/_shared/help.mjs';
// @ts-expect-error — plain .mjs plugin module, no types
import { MESSAGES as DISCORD } from '../../plugins/discord/lib/messages.mjs';
// @ts-expect-error — plain .mjs plugin module, no types
import { MESSAGES as TELEGRAM } from '../../plugins/telegram/lib/messages.mjs';
// @ts-expect-error — plain .mjs plugin module, no types
import { MESSAGES as WHATSAPP } from '../../plugins/whatsapp/lib/messages.mjs';

describe('shared plugin service messages', () => {
  it('SHARED_MESSAGES exposes the same key set in both languages', () => {
    expect(Object.keys(SHARED_MESSAGES.en).sort()).toEqual(Object.keys(SHARED_MESSAGES.cs).sort());
    expect(SHARED_MESSAGES.en.noModels).toContain('No models configured');
    expect(SHARED_MESSAGES.cs.noModels).toContain('modely');
  });

  it('every adapter inherits the shared keys with identical values', () => {
    for (const M of [DISCORD, TELEGRAM, WHATSAPP]) {
      for (const lang of ['en', 'cs'] as const) {
        expect(M[lang].noModels).toBe(SHARED_MESSAGES[lang].noModels);
        expect(M[lang].restarting).toBe(SHARED_MESSAGES[lang].restarting);
        // The function keys stay referentially shared too (spread copies the reference).
        expect(M[lang].compacted(42)).toBe(SHARED_MESSAGES[lang].compacted(42));
      }
    }
  });
});

describe('shared /help renderer', () => {
  it('substitutes the container noun and its Czech locative case', () => {
    const [modelLine, contextLine] = renderHelpLines({
      lang: 'cs', commands: ['model', 'context'], mono: (s: string) => s, place: 'kanál', placeLoc: 'kanálu',
    });
    expect(modelLine).toBe('/model — výběr AI modelu pro tento kanál');
    expect(contextLine).toBe('/context — navázat v tomto kanálu na jednu ze svých konverzací');
  });

  it('placeLoc defaults to place when omitted (English has no cases)', () => {
    const [line] = renderHelpLines({ lang: 'en', commands: ['context'], mono: (s: string) => s, place: 'chat' });
    expect(line).toBe('/context — continue this chat in one of your conversations');
  });

  it('mono wraps the command token in the surface style', () => {
    const [line] = renderHelpLines({ lang: 'en', commands: ['stop'], mono: (s: string) => '`' + s + '`', place: 'chat' });
    expect(line).toBe('`/stop` — stop the running agent');
  });

  it('describes the same commands in both languages', () => {
    expect(Object.keys(HELP_DESCRIPTIONS.en).sort()).toEqual(Object.keys(HELP_DESCRIPTIONS.cs).sort());
  });
});

describe('/help stays in sync across surfaces (the Telegram /context drift regression)', () => {
  it('lists /context in every surface and language that exposes it', () => {
    // Discord + Telegram expose /context; both languages must list it (Telegram cs previously dropped it).
    for (const M of [DISCORD, TELEGRAM]) {
      expect(M.en.help('Elowen')).toContain('/context');
      expect(M.cs.help('Elowen')).toContain('/context');
    }
  });

  it('WhatsApp omits the commands it has no surface for (/voice, /display)', () => {
    expect(WHATSAPP.en.help('Elowen')).not.toContain('/voice');
    expect(WHATSAPP.en.help('Elowen')).not.toContain('/display');
    // …but Discord, which does have them, lists them.
    expect(DISCORD.en.help('Elowen')).toContain('/voice');
    expect(DISCORD.en.help('Elowen')).toContain('/display');
  });
});
