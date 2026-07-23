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
import { MESSAGES as MSTEAMS } from '../../plugins/msteams/lib/messages.mjs';

describe('shared plugin service messages', () => {
  it('SHARED_MESSAGES exposes the same key set in every language', () => {
    const en = Object.keys(SHARED_MESSAGES.en).sort();
    expect(Object.keys(SHARED_MESSAGES.cs).sort()).toEqual(en);
    expect(Object.keys(SHARED_MESSAGES.sk).sort()).toEqual(en);
    expect(SHARED_MESSAGES.en.noModels).toContain('No models configured');
    expect(SHARED_MESSAGES.cs.noModels).toContain('modely');
    expect(SHARED_MESSAGES.sk.noModels).toContain('modely');
  });

  it('every adapter inherits the shared keys with identical values', () => {
    for (const M of [DISCORD, TELEGRAM, WHATSAPP, MSTEAMS]) {
      for (const lang of ['en', 'cs', 'sk'] as const) {
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
      lang: 'cs', commands: [{ name: 'model' }, { name: 'context' }], mono: (s: string) => s, place: 'kanál', placeLoc: 'kanálu',
    });
    expect(modelLine).toBe('/model — výběr AI modelu pro tento kanál');
    expect(contextLine).toBe('/context — navázat v tomto kanálu na jednu ze svých konverzací');
  });

  it('substitutes the container noun and its Slovak locative case', () => {
    const [modelLine, contextLine] = renderHelpLines({
      lang: 'sk', commands: [{ name: 'model' }, { name: 'context' }], mono: (s: string) => s, place: 'kanál', placeLoc: 'kanáli',
    });
    expect(modelLine).toBe('/model — výber AI modelu pre tento kanál');
    expect(contextLine).toBe('/context — nadviazať v tomto kanáli na jednu zo svojich konverzácií');
  });

  it('placeLoc defaults to place when omitted (English has no cases)', () => {
    const [line] = renderHelpLines({ lang: 'en', commands: [{ name: 'context' }], mono: (s: string) => s, place: 'chat' });
    expect(line).toBe('/context — continue this chat in one of your conversations');
  });

  it('mono wraps the command token in the surface style', () => {
    const [line] = renderHelpLines({ lang: 'en', commands: [{ name: 'stop' }], mono: (s: string) => '`' + s + '`', place: 'chat' });
    expect(line).toBe('`/stop` — stop the running agent');
  });

  it('falls back to a plugin command\'s own English description while still localizing built-ins', () => {
    // A name keyed in HELP_DESCRIPTIONS renders localized; anything else (a plugin prompt command) uses the
    // command's own description verbatim, so a plugin command can never be dropped from a surface's /help.
    const lines = renderHelpLines({
      lang: 'cs', commands: [{ name: 'stop', description: 'IGNORED for a built-in' }, { name: 'deploy', description: 'Ship it to prod' }],
      mono: (s: string) => s, place: 'chat',
    });
    expect(lines[0]).toBe('/stop — zastavit běžícího agenta'); // built-in stays localized (own desc ignored)
    expect(lines[1]).toBe('/deploy — Ship it to prod');        // plugin: English description verbatim
  });

  it('describes the same commands in every language', () => {
    const en = Object.keys(HELP_DESCRIPTIONS.en).sort();
    expect(Object.keys(HELP_DESCRIPTIONS.cs).sort()).toEqual(en);
    expect(Object.keys(HELP_DESCRIPTIONS.sk).sort()).toEqual(en);
  });
});

describe('/help renders the passed command list (single-source, no drift)', () => {
  const list = (names: string[]) => names.map((name) => ({ name }));

  it('lists /context localized in every surface and language that passes it in', () => {
    // help() renders whatever list it is handed; a surface that exposes /context passes it in, and the
    // shared renderer localizes it in every language (the exact Telegram cs drift this design removes).
    for (const M of [DISCORD, TELEGRAM]) {
      expect(M.en.help('Elowen', list(['context']))).toContain('/context');
      expect(M.cs.help('Elowen', list(['context']))).toContain('/context');
      expect(M.sk.help('Elowen', list(['context']))).toContain('/context');
    }
  });

  it('every text surface that gates /fast has a fastUsage string in every language', () => {
    // The shared core replies msg.fastUsage on an invalid /fast arg; Telegram + WhatsApp accept free text,
    // so every language must carry the key (Telegram cs previously lacked it → a silent, zero-reply path).
    for (const M of [TELEGRAM, WHATSAPP]) {
      expect(typeof M.en.fastUsage).toBe('string');
      expect(typeof M.cs.fastUsage).toBe('string');
      expect(typeof M.sk.fastUsage).toBe('string');
    }
  });

  it('renders a plugin prompt-command from the list via its own English description', () => {
    const body = DISCORD.en.help('Elowen', [{ name: 'stop' }, { name: 'deploy', description: 'Ship it' }]);
    expect(body).toContain('Elowen on Discord');
    expect(body).toContain('/stop'); // built-in still localized from HELP_DESCRIPTIONS
    expect(body).toContain('`/deploy` — Ship it'); // plugin command appears, fallback description
  });
});
