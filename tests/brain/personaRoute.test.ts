import { describe, it, expect } from 'vitest';
import { personaTemplatesFor, PERSONA_BASE, PERSONA_CODEX, PERSONA_PLATFORM_OVERLAY, PERSONA_SCHEDULED } from '../../src/brain/session/personaRoute.js';
import type { BrainProviderEntry } from '../../src/brain/providers.js';

const codex = (over: Partial<BrainProviderEntry> = {}): BrainProviderEntry => ({
  id: 'openai-codex', type: 'oauth-openai-codex', models: ['gpt-5.6-sol'], codeModeEnabled: true, ...over,
} as BrainProviderEntry);

const anthropic = (): BrainProviderEntry => ({ id: 'anthropic', type: 'oauth-anthropic', models: ['claude-opus-5'] } as BrainProviderEntry);

describe('personaTemplatesFor', () => {
  // The behaviour that existed before the resolver, pinned first: a change to the codex branch below
  // must not move the prompt of any other session, because that would re-charge its cached prefix.
  it('owner chat renders the base template alone', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: true, provider: anthropic(), modelId: 'claude-opus-5' }))
      .toEqual({ base: PERSONA_BASE });
  });

  it('a shared room appends the platform overlay', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: false, provider: anthropic(), modelId: 'claude-opus-5' }))
      .toEqual({ base: PERSONA_BASE, overlay: PERSONA_PLATFORM_OVERLAY });
  });

  it('a scheduled turn wins over everything, including code mode', () => {
    expect(personaTemplatesFor({ scheduled: true, ownerChatShape: false, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ base: PERSONA_SCHEDULED });
  });

  it('a code-mode session renders the codex variant, overlay rules unchanged', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: true, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ base: PERSONA_CODEX });
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: false, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ base: PERSONA_CODEX, overlay: PERSONA_PLATFORM_OVERLAY });
  });

  // Each gate of `codeModeApplies` on its own keeps the base template. The switch being off is the
  // default state of every installation, so this is the case that must never drift.
  it('keeps the base template when any code-mode gate is closed', () => {
    const off = { scheduled: false, ownerChatShape: true } as const;
    expect(personaTemplatesFor({ ...off, provider: codex({ codeModeEnabled: false }), modelId: 'gpt-5.6-sol' }).base).toBe(PERSONA_BASE);
    expect(personaTemplatesFor({ ...off, provider: codex(), modelId: 'gpt-5.5' }).base).toBe(PERSONA_BASE);
    expect(personaTemplatesFor({ ...off, provider: anthropic(), modelId: 'gpt-5.6-sol' }).base).toBe(PERSONA_BASE);
    expect(personaTemplatesFor({ ...off, provider: undefined, modelId: 'gpt-5.6-sol' }).base).toBe(PERSONA_BASE);
  });
});
