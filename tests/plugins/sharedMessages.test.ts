import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { SHARED_MESSAGES } from '../../packages/plugin-shared/messages.mjs';
// @ts-expect-error — plain .mjs plugin module, no types
import { renderHelpLines, HELP_DESCRIPTIONS } from '../../packages/plugin-shared/help.mjs';

// Every chat adapter now lives in the plugin registry, and each one asserts there that it inherits these
// texts verbatim from the published elowen-plugin-shared. What is testable HERE is the shared package
// itself: that its key sets line up across languages and that its /help renderer behaves.

describe('shared plugin service messages', () => {
  it('SHARED_MESSAGES exposes the same key set in every language', () => {
    const en = Object.keys(SHARED_MESSAGES.en).sort();
    expect(Object.keys(SHARED_MESSAGES.cs).sort()).toEqual(en);
    expect(Object.keys(SHARED_MESSAGES.sk).sort()).toEqual(en);
    expect(SHARED_MESSAGES.en.noModels).toContain('No models configured');
    expect(SHARED_MESSAGES.cs.noModels).toContain('modely');
    expect(SHARED_MESSAGES.sk.noModels).toContain('modely');
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
