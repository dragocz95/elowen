import { describe, it, expect } from 'vitest';
import { catalogModelCost, catalogModelVision, descriptorCapabilities, inferredModelCapabilities } from '../../src/brain/modelCapabilities.js';

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
    // deepseek-r1 thinks, yet exposes only an on/off toggle — advertising an effort knob it does not
    // have would put an unsupported `reasoning_effort` on every request.
    expect(descriptorCapabilities('elowen-openrouter', 'deepseek/deepseek-r1').reasoning).toBe(true);
    expect(levels('openrouter', 'deepseek/deepseek-r1')).toEqual([]);
  });

  it('offers low/medium/high for Qwen thinking models — their effort IS settable, via thinking_budget', () => {
    // models.dev says "reasons, effort not settable" for the whole Qwen family because the wire knob is
    // DashScope's `thinking_budget` (or OpenRouter's `reasoning` object), never `reasoning_effort`.
    // Elowen maps the selected effort onto that wire at request time, so the picker must offer the
    // ladder instead of hiding the control ("this model has no reasoning-effort levels").
    expect(levels('alibaba', 'qwen3.7-max')).toEqual(['low', 'medium', 'high']);
    expect(levels('alibaba', 'qwen3.6-flash')).toEqual(['low', 'medium', 'high']);
    expect(levels('ollama', 'qwen3.5:397b')).toEqual(['low', 'medium', 'high']);
    // An id too new for the catalog still gets the family ladder — a fresh MAX release is usable before
    // the table is refreshed.
    expect(levels('alibaba', 'qwen3.8-max-preview')).toEqual(['low', 'medium', 'high']);
    // The catalog still vetoes the non-reasoning siblings, and pre-3.5 unknowns are not guessed.
    expect(descriptorCapabilities('elowen-alibaba', 'qwen3-coder-plus').reasoning).toBe(false);
    expect(descriptorCapabilities('elowen-relay', 'qwen2-unknown-variant').reasoning).toBe(false);
  });

  it('keeps a ladder an endpoint publishes itself, but never carries one to another endpoint by name', () => {
    // OpenRouter's own row for qwen3.8-max lists minimal and xhigh, and its `reasoning` object really does
    // accept them, so that endpoint keeps its full ladder instead of being flattened to the family's.
    expect(levels('openrouter', 'qwen/qwen3.8-max')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    // That same ladder must NOT reach DashScope, which has no row of its own and is matched only by name.
    // There the effort becomes a `thinking_budget`, defined for low/medium/high alone, so an offered
    // `minimal` would ride out as a raw reasoning_effort the endpoint never documented.
    expect(levels('alibaba', 'qwen3.8-max-preview')).toEqual(['low', 'medium', 'high']);
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
    expect(codex.labels).toEqual({ xhigh: 'ultra' });
    expect(inferredModelCapabilities('openai-codex', 'gpt-5.6').levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

// Asserted on catalog INVARIANTS, not the live figures a refresh moves: that a model resolves to SOME
// price via each of the three tiers, that an ambiguous or unknown one resolves to none, and that the same
// price is reached however the id is spelled. The exact dollar amounts are models.dev's, not ours to pin.
describe('catalogModelCost — a proxied model reports real spend instead of $0', () => {
  const priced = (provider: string, model: string) => catalogModelCost(`elowen-${provider}`, model);

  it('prices a bare model name only when every catalogued endpoint agrees on it', () => {
    // kimi-k3 is listed identically by Moonshot and OpenRouter, so a relay serving it as a bare `kimi-k3`
    // (no namespace, no own catalog row) is priced from that agreement — the headline case, was $0.
    const k3 = priced('acme-relay', 'kimi-k3');
    expect(k3?.input).toBeGreaterThan(0);
    expect(k3?.output).toBeGreaterThan(0);
    // Spelled with the upstream namespace it must reach the SAME price (tier 2 vs tier 3, one figure).
    expect(catalogModelCost('elowen-relay', 'moonshotai/kimi-k3')).toEqual(k3);
  });

  it('reads the upstream price a relay names, even when the relay itself is uncatalogued', () => {
    // `deepseek/deepseek-v4-flash` says which upstream it proxies; the price is the upstream model's own.
    const flash = priced('acme-relay', 'deepseek/deepseek-v4-flash');
    expect(flash?.input).toBeGreaterThan(0);
    expect(flash).toEqual(catalogModelCost('deepseek', 'deepseek-v4-flash'));
  });

  it('leaves a model unpriced rather than guess when the catalog disagrees or is silent', () => {
    // glm-5.2 is priced differently by Z.AI, OpenRouter and NVIDIA — no agreement, so no guess.
    expect(priced('acme-relay', 'glm-5.2')).toBeUndefined();
    // ollama publishes no price for its glm-5.2, so the namespaced form is unpriced too.
    expect(priced('acme-relay', 'ollama/glm-5.2')).toBeUndefined();
    // A model in no catalog at all stays $0 (undefined here), never invented.
    expect(priced('acme-relay', 'some-private-model-xyz')).toBeUndefined();
  });

  it('never prices Codex OAuth from models.dev — ChatGPT bills on its own catalog', () => {
    expect(catalogModelCost('openai-codex', 'gpt-5.6')).toBeUndefined();
  });
});

// Vision resolves through the same three tiers as cost. A KNOWN text-only model returns false so
// modelEntry declares `input:['text']` and pi-ai downgrades a tool-read image gracefully; an unknown model
// returns undefined so it keeps the image-declaring default and vision is never wrongly stripped.
describe('catalogModelVision — a text-only model is known, so pi-ai can downgrade instead of 400', () => {
  const vision = (provider: string, model: string) => catalogModelVision(`elowen-${provider}`, model);

  it('reports a catalogued text-only model false and a vision model true (direct endpoint row)', () => {
    expect(vision('deepseek', 'deepseek-v4-flash')).toBe(false);
    expect(vision('openai', 'gpt-5.6')).toBe(true);
    expect(vision('anthropic', 'claude-opus-4-8')).toBe(true);
  });

  it('reads the upstream a relay names (tier 2) and an agreed bare name (tier 3)', () => {
    expect(vision('acme-relay', 'deepseek/deepseek-v4-flash')).toBe(false);
    // kimi-k3 accepts images on every catalogued endpoint, so a bare relay id resolves to true.
    expect(vision('acme-relay', 'kimi-k3')).toBe(true);
  });

  it('is undefined for an unknown model (caller keeps the image default) and for Codex OAuth', () => {
    expect(vision('acme-relay', 'some-private-model-xyz')).toBeUndefined();
    expect(catalogModelVision('openai-codex', 'gpt-5.6')).toBeUndefined();
  });
});
