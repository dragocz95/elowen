import { describe, expect, it } from 'vitest';
import type { BrainProviderEntry } from '../../src/brain/providers.js';
import {
  CODE_MODE_ALWAYS_VISIBLE_TOOLS,
  codeModeApplies,
  codeModeVisibilityFor,
  isCodeModeCapableModel,
} from '../../src/brain/session/codeModeRoute.js';

function entry(overrides: Partial<BrainProviderEntry> = {}): BrainProviderEntry {
  return {
    id: 'chatgpt',
    label: 'ChatGPT',
    type: 'oauth-openai-codex',
    baseUrl: '',
    models: ['gpt-5.6-sol'],
    apiKey: null,
    codeModeEnabled: true,
    ...overrides,
  } as BrainProviderEntry;
}

describe('isCodeModeCapableModel', () => {
  it('accepts gpt-5.6 and newer', () => {
    expect(isCodeModeCapableModel('gpt-5.6-sol')).toBe(true);
    expect(isCodeModeCapableModel('gpt-5.6-terra')).toBe(true);
    expect(isCodeModeCapableModel('gpt-5.6')).toBe(true);
    expect(isCodeModeCapableModel('gpt-6-astra')).toBe(true);
    expect(isCodeModeCapableModel('gpt-7')).toBe(true);
  });

  it('rejects older GPT models', () => {
    expect(isCodeModeCapableModel('gpt-5.5')).toBe(false);
    expect(isCodeModeCapableModel('gpt-5.4-mini')).toBe(false);
    expect(isCodeModeCapableModel('gpt-5')).toBe(false);
    expect(isCodeModeCapableModel('gpt-4.1')).toBe(false);
  });

  it('rejects anything that is not a gpt id', () => {
    expect(isCodeModeCapableModel('claude-opus-5')).toBe(false);
    expect(isCodeModeCapableModel('glm-5.3')).toBe(false);
    expect(isCodeModeCapableModel('')).toBe(false);
  });
});

describe('codeModeApplies', () => {
  it('needs all three gates', () => {
    expect(codeModeApplies(entry(), 'gpt-5.6-sol')).toBe(true);
  });

  it('is off without the operator switch', () => {
    const without = entry();
    delete (without as { codeModeEnabled?: true }).codeModeEnabled;
    expect(codeModeApplies(without, 'gpt-5.6-sol')).toBe(false);
  });

  it('is off for a provider that is not the ChatGPT Codex endpoint', () => {
    expect(codeModeApplies(entry({ type: 'openai' }), 'gpt-5.6-sol')).toBe(false);
    expect(codeModeApplies(entry({ type: 'oauth-anthropic' }), 'gpt-5.6-sol')).toBe(false);
  });

  it('is off for an older model on a qualifying provider', () => {
    expect(codeModeApplies(entry(), 'gpt-5.5')).toBe(false);
  });

  it('is off when the provider is unknown', () => {
    expect(codeModeApplies(undefined, 'gpt-5.6-sol')).toBe(false);
  });
});

describe('codeModeVisibilityFor', () => {
  const all = ['Read', 'Bash', 'AskUserQuestion', 'mcp__gh__issues', 'exec', 'wait'];

  it('shows only the code-mode pair and the always-visible tools', () => {
    const { deferred } = codeModeVisibilityFor(all, ['exec', 'wait']);
    const visible = all.filter((name) => !deferred.has(name));
    expect(visible).toEqual(['AskUserQuestion', 'exec', 'wait']);
  });

  it('withholds every other tool without removing it', () => {
    const { deferred } = codeModeVisibilityFor(all, ['exec', 'wait']);
    expect([...deferred].sort()).toEqual(['Bash', 'Read', 'mcp__gh__issues']);
  });

  it('never marks a tool as activated, because a script never fetches one into the prompt', () => {
    expect(codeModeVisibilityFor(all, ['exec', 'wait']).activated.size).toBe(0);
  });

  it('keeps the interaction tool visible so the model can always ask the user', () => {
    for (const name of CODE_MODE_ALWAYS_VISIBLE_TOOLS) {
      expect(codeModeVisibilityFor([name], []).deferred.has(name)).toBe(false);
    }
  });
});
