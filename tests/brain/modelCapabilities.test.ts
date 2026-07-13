import { describe, it, expect } from 'vitest';
import { descriptorCapabilities, inferredModelCapabilities } from '../../src/brain/modelCapabilities.js';

/** The effort ladder Elowen would offer for a model on a custom endpoint registered as `elowen-<id>`. */
const levels = (provider: string, model: string) => inferredModelCapabilities(`elowen-${provider}`, model).levels;

describe('descriptorCapabilities — models.dev catalog', () => {
  it('offers the efforts a reasoning model really accepts (the ladder is per endpoint, not per name)', () => {
    // The regression that started this: GLM was in no family regex, so it was declared non-reasoning and
    // every effort change was refused. It reasons — but only at high/max, never at low/medium.
    expect(levels('ollama', 'glm-5.2')).toEqual(['high', 'max']);
    expect(levels('zai', 'glm-5.2')).toEqual(['high', 'max']);
    // The SAME model through OpenRouter accepts a different ladder. A name heuristic cannot express this;
    // offering `max` here (or `low` anywhere) would send an effort the endpoint rejects.
    expect(levels('openrouter', 'z-ai/glm-5.2')).toEqual(['high', 'xhigh']);
  });

  it('reads a self-hosted pull through its tag', () => {
    // `ollama pull glm-5.2` lands as `glm-5.2:latest`; the capability belongs to the model, not the tag.
    expect(levels('ollama-local', 'glm-5.2:latest')).toEqual(['high', 'max']);
    // A tag the catalog DOES publish keeps its own row rather than being collapsed to the bare id.
    expect(levels('ollama', 'gpt-oss:120b')).toEqual(['low', 'medium', 'high']);
  });

  it('marks a model that reasons without a settable effort as reasoning, but offers no levels', () => {
    // qwen3.5 thinks, yet exposes only an on/off toggle — advertising an effort knob it does not have
    // would put an unsupported `reasoning_effort` on every request.
    expect(descriptorCapabilities('elowen-ollama', 'qwen3.5:397b').reasoning).toBe(true);
    expect(levels('ollama', 'qwen3.5:397b')).toEqual([]);
    expect(levels('openrouter', 'deepseek/deepseek-r1')).toEqual([]);
  });

  it('lets the catalog veto a name pattern that recognises a non-reasoning sibling', () => {
    // The chat, vision and speech variants carry their reasoning sibling's family name, so the OpenAI and
    // Gemini patterns claim them — and sending `reasoning_effort` to one is a 400. A model the catalog
    // explicitly reports as non-reasoning overrules every pattern.
    expect(descriptorCapabilities('elowen-openai', 'gpt-5.3-chat-latest').reasoning).toBe(false);
    expect(descriptorCapabilities('elowen-google', 'gemini-2.5-flash-preview-tts').reasoning).toBe(false);
    // The families themselves keep their curated ladders — the catalog does not touch them (`minimal` is
    // deliberately offered and normalised onto the wire's `low`).
    expect(levels('openai', 'gpt-5.6')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('reads a private relay through the upstream it names', () => {
    // A relay is in no catalog under its own name, but it says which upstream it proxies by namespacing
    // the model — the shape OpenRouter publishes. The ladder is the upstream model's.
    expect(levels('ai-relay', 'ollama/glm-5.2')).toEqual(['high', 'max']);
    expect(levels('ai-relay', 'z-ai/glm-5.2')).toEqual(['high', 'max']);
    // …and a namespaced id on a provider the catalog DOES know keeps that provider's own answer, which
    // differs: the same model accepts xhigh through OpenRouter and max on Z.AI.
    expect(levels('openrouter', 'z-ai/glm-5.2')).toEqual(['high', 'xhigh']);
  });

  it('recognises a model by name inside whatever an unknown endpoint calls it', () => {
    // A relay free to name its own build (`glm-5.2-fp8`) still serves glm-5.2. With the endpoint unknown,
    // only the efforts EVERY endpoint serving it accepts are safe — high is common to all, while max
    // (Z.AI) and xhigh (OpenRouter) are not, and offering either would be a 400 on the other.
    expect(levels('relay', 'glm-5.2-fp8')).toEqual(['high']);
    expect(levels('relay', 'GLM-5.2')).toEqual(['high']);
    // The match may not cut a version short: this is gpt-5.3, not gpt-5, and it does not reason at all.
    expect(descriptorCapabilities('elowen-relay', 'gpt-5.3-chat-latest').reasoning).toBe(false);
  });

  it('falls back to the family heuristics for a model the catalog has not published', () => {
    // A version the catalog has never seen still gets the OpenAI family ladder and its `ultra` label, so a
    // fresh release is usable before the table is refreshed.
    expect(levels('relay', 'openai/gpt-5.9-sol')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(descriptorCapabilities('elowen-relay', 'openai/gpt-5.9-sol').labels).toEqual({ xhigh: 'ultra' });
  });

  it('still refuses to guess for an unknown id', () => {
    // Unchanged contract: a plain chat model on a private endpoint must never be sent `reasoning_effort`.
    expect(descriptorCapabilities('elowen-relay', 'my-private-chat-model')).toEqual({ reasoning: false });
    expect(descriptorCapabilities('elowen-relay', 'text-embedding-3-large')).toEqual({ reasoning: false });
  });

  it('keeps Codex OAuth on its own rule — ChatGPT is not a models.dev endpoint', () => {
    const codex = descriptorCapabilities('openai-codex', 'gpt-5.6');
    expect(codex.reasoning).toBe(true);
    expect(codex.fast).toBe(true);
    expect(codex.labels).toEqual({ xhigh: 'ultra' });
    expect(inferredModelCapabilities('openai-codex', 'gpt-5.6').levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});
