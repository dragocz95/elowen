import { describe, expect, it } from 'vitest';
import type { BrainProviderEntry } from '../../src/brain/providers.js';
import {
  CODE_MODE_ALWAYS_VISIBLE_TOOLS,
  codeModeApplies,
  codeModeVisibilityFor,
  isCodeModeCapableProvider,
  usesCodexRequestShape,
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

describe('usesCodexRequestShape', () => {
  it('is the ChatGPT account and nothing else', () => {
    expect(usesCodexRequestShape({ type: 'oauth-openai-codex' })).toBe(true);
    // A third-party Responses endpoint can carry `exec` but ignores `additional_tools` outright, so it
    // must keep the ordinary top-level tool declaration.
    expect(usesCodexRequestShape({ type: 'openai' })).toBe(false);
    expect(usesCodexRequestShape({ type: 'oauth-anthropic' })).toBe(false);
  });
});

describe('codeModeApplies', () => {
  it('needs both gates', () => {
    expect(codeModeApplies(entry())).toBe(true);
  });

  it('is off without the operator switch', () => {
    const without = entry();
    delete (without as { codeModeEnabled?: true }).codeModeEnabled;
    expect(codeModeApplies(without)).toBe(false);
  });

  it('is off for a provider whose wire cannot carry the tool', () => {
    // `exec` is declared through constrained sampling, which only the Responses wires serialise. A default
    // OpenAI-compatible endpoint is Chat Completions, and Anthropic is neither.
    expect(codeModeApplies(entry({ type: 'openai', baseUrl: 'https://compat.example/v1' }))).toBe(false);
    expect(codeModeApplies(entry({ type: 'oauth-anthropic' }))).toBe(false);
  });

  it('applies to an API-key provider on the Responses wire', () => {
    expect(codeModeApplies(entry({ type: 'openai', api: 'openai-responses', baseUrl: 'https://r.openai.azure.com/openai/v1' }))).toBe(true);
  });

  it('has no model gate: the operator decides which models are worth running this way', () => {
    // A third-party Responses endpoint serving a non-GPT model is exactly the case this allows. pi-ai
    // downgrades the grammar tool to a plain function tool when the model cannot take one, so nothing on
    // the wire breaks; whether the model BATCHES well is a measurement, not a property of its id.
    const dashscope = entry({
      type: 'openai', api: 'openai-responses',
      baseUrl: 'https://token-plan.example/compatible-mode/v1', models: ['qwen3.8-flash'],
    });
    expect(codeModeApplies(dashscope)).toBe(true);
    expect(codeModeApplies(entry({ models: ['gpt-5.5'] }))).toBe(true);
  });

  it('is off when the provider is unknown', () => {
    expect(codeModeApplies(undefined)).toBe(false);
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
