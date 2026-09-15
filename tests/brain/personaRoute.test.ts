import { describe, it, expect } from 'vitest';
import {
  personaTemplatesFor,
  PERSONA_BASE,
  PERSONA_HARNESS,
  PERSONA_PLATFORM_OVERLAY,
  PERSONA_SCHEDULED,
  PERSONA_WORK,
  PERSONA_WORK_CODEX,
} from '../../src/brain/session/personaRoute.js';
import type { BrainProviderEntry } from '../../src/brain/providers.js';

const codex = (over: Partial<BrainProviderEntry> = {}): BrainProviderEntry => ({
  id: 'openai-codex', type: 'oauth-openai-codex', models: ['gpt-5.6-sol'], codeModeEnabled: true, ...over,
} as BrainProviderEntry);

const anthropic = (): BrainProviderEntry => ({ id: 'anthropic', type: 'oauth-anthropic', models: ['claude-opus-5'] } as BrainProviderEntry);

describe('personaTemplatesFor', () => {
  // The behaviour that existed before the resolver, pinned first: a change to the codex branch below
  // must not move the prompt of any other session, because that would re-charge its cached prefix.
  it('owner chat composes identity, harness and our own work rules', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: true, provider: anthropic(), modelId: 'claude-opus-5' }))
      .toEqual({ parts: [PERSONA_BASE, PERSONA_HARNESS, PERSONA_WORK] });
  });

  it('a shared room appends the platform overlay after the parts', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: false, provider: anthropic(), modelId: 'claude-opus-5' }))
      .toEqual({ parts: [PERSONA_BASE, PERSONA_HARNESS, PERSONA_WORK], overlay: PERSONA_PLATFORM_OVERLAY });
  });

  it('a scheduled turn wins over everything, including code mode, and takes no other part', () => {
    expect(personaTemplatesFor({ scheduled: true, ownerChatShape: false, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ parts: [PERSONA_SCHEDULED] });
  });

  // Only the WORK part changes: identity and harness are ours whatever the model was trained on.
  it('a code-mode session swaps only the work rules, overlay rules unchanged', () => {
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: true, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ parts: [PERSONA_BASE, PERSONA_HARNESS, PERSONA_WORK_CODEX] });
    expect(personaTemplatesFor({ scheduled: false, ownerChatShape: false, provider: codex(), modelId: 'gpt-5.6-sol' }))
      .toEqual({ parts: [PERSONA_BASE, PERSONA_HARNESS, PERSONA_WORK_CODEX], overlay: PERSONA_PLATFORM_OVERLAY });
  });

  // Each gate of `codeModeApplies` on its own keeps our own work rules. The switch being off is the
  // default state of every installation, so this is the case that must never drift.
  it('keeps our work rules when any code-mode gate is closed', () => {
    const off = { scheduled: false, ownerChatShape: true } as const;
    const work = (provider: BrainProviderEntry | undefined, modelId: string): string =>
      personaTemplatesFor({ ...off, provider, modelId }).parts.at(-1)!;
    expect(work(codex({ codeModeEnabled: false }), 'gpt-5.6-sol')).toBe(PERSONA_WORK);
    expect(work(codex(), 'gpt-5.5')).toBe(PERSONA_WORK);
    expect(work(anthropic(), 'gpt-5.6-sol')).toBe(PERSONA_WORK);
    expect(work(undefined, 'gpt-5.6-sol')).toBe(PERSONA_WORK);
  });
});
