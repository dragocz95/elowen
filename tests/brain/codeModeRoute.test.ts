import { describe, expect, it } from 'vitest';
import type { BrainProviderEntry } from '../../src/brain/providers.js';
import {
  CODE_MODE_ALWAYS_VISIBLE_TOOLS,
  codeModeApplies,
  codeModeVisibilityFor,
  isCodeModeCapableModel,
  isCodeModeCapableProvider,
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

  it('is off for a provider whose wire cannot carry a grammar tool', () => {
    // `exec` is a grammar-constrained custom tool, which only the Responses wires serialise. A default
    // OpenAI-compatible endpoint is Chat Completions, and Anthropic is neither.
    expect(codeModeApplies(entry({ type: 'openai', baseUrl: 'https://compat.example/v1' }), 'gpt-5.6-sol')).toBe(false);
    expect(codeModeApplies(entry({ type: 'oauth-anthropic' }), 'gpt-5.6-sol')).toBe(false);
  });

  it('applies to an API-key provider on the Responses wire', () => {
    const azure = entry({ type: 'openai', api: 'openai-responses', baseUrl: 'https://r.openai.azure.com/openai/v1' });
    expect(codeModeApplies(azure, 'gpt-5.6-luna')).toBe(true);
    expect(codeModeApplies(azure, 'gpt-5.5')).toBe(false);
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

describe('isCodeModeCapableProvider', () => {
  it('accepts the ChatGPT account and every Responses endpoint', () => {
    expect(isCodeModeCapableProvider({ type: 'oauth-openai-codex', baseUrl: '' })).toBe(true);
    expect(isCodeModeCapableProvider({ type: 'openai', api: 'openai-responses', baseUrl: 'https://r.openai.azure.com/openai/v1' })).toBe(true);
    // api.openai.com defaults to Responses without an explicit api.
    expect(isCodeModeCapableProvider({ type: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
  });

  it('rejects Chat Completions and non-OpenAI wires', () => {
    expect(isCodeModeCapableProvider({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' })).toBe(false);
    expect(isCodeModeCapableProvider({ type: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isCodeModeCapableProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(false);
    expect(isCodeModeCapableProvider({ type: 'oauth-anthropic', baseUrl: '' })).toBe(false);
  });
});
