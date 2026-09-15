import { describe, it, expect } from 'vitest';
import { modelIconSlug } from '../../lib/modelIcon';

const slugOf = (name: string) => modelIconSlug(name)?.slug;
/** The brand, without the variant: whether lobe-icons ships a `-color` mark for a given brand is its
 *  business, and these tests are about which brand a name resolves to. */
const brandOf = (name: string) => modelIconSlug(name)?.slug.replace(/-color$/, '');

describe('modelIconSlug', () => {
  it('brands the Kimi Code models, which never say "kimi"', () => {
    // The Kimi Code endpoint names its models `k3` / `k2p7`. Without a rule for the bare id they fall all
    // the way through and render the generic chip glyph.
    expect(slugOf('k3')).toBe('kimi-color');
    expect(slugOf('k2p7')).toBe('kimi-color');
    expect(slugOf('k2p5')).toBe('kimi-color');
    // `\bk2\b` cannot see this one: the `p` leaves no word boundary after k2.
    expect(slugOf('k2p6')).toBe('kimi-color');
    // A model Kimi has not shipped yet still reads as Kimi — the shape is the endpoint's naming scheme,
    // not a guess about one id.
    expect(slugOf('k4')).toBe('kimi-color');
    expect(slugOf('kimi-coding/k3')).toBe('kimi-color');
  });

  it('keeps the bare-id rule anchored to a whole segment', () => {
    // A loose /k\d/ would brand half the catalog. These must NOT read as Kimi.
    expect(brandOf('k2p7-turbo')).not.toBe('kimi');
    expect(brandOf('gpt-k3-preview')).toBe('openai');
    expect(brandOf('grok-4')).toBe('grok');
    expect(brandOf('gemini-3.5-flash')).toBe('gemini');
  });

  it('gives the account row GitHub\'s mark, not Microsoft\'s', () => {
    // `copilot-color` is Microsoft Copilot — a different product. GitHub's own mark ships mono-only.
    expect(slugOf('copilot')).toBe('githubcopilot');
    expect(slugOf('github-copilot')).toBe('githubcopilot');
    expect(modelIconSlug('copilot')?.color).toBe(false);
  });

  it('brands Codex with the OpenAI mark, never a standalone Codex glyph', () => {
    // `openai-codex` is the PI provider id behind the ChatGPT OAuth account and `codex:` the CLI engine.
    // Both are OpenAI products, so every surface that draws a model icon has to wear the OpenAI mark.
    expect(slugOf('openai-codex')).toBe('openai');
    expect(slugOf('codex:gpt-5.5')).toBe('openai');
    expect(slugOf('gpt-5.1-codex')).toBe('openai');
    // A bare id carries no "gpt" to match on. It still has to brand as OpenAI rather than fall through to
    // the generic chip glyph.
    expect(brandOf('codex')).toBe('openai');
    expect(modelIconSlug('Codex')?.color).toBe(false);
  });

  it('lets the model brand beat the runner brand', () => {
    // The ordering contract: `github-copilot/claude-opus-4.8` is a CLAUDE model served through Copilot, so
    // it must wear the Claude mark. Same reason `ollama/deepseek-…` is a DeepSeek model. Adding the copilot
    // rule anywhere above the model brands silently repaints all 29 catalogued Copilot models.
    expect(brandOf('github-copilot/claude-opus-4.8')).toBe('claude');
    expect(brandOf('github-copilot/gpt-5-mini')).toBe('openai');
    expect(brandOf('github-copilot/kimi-k2.7-code')).toBe('kimi');
    expect(brandOf('ollama/deepseek-v4-pro')).toBe('deepseek');
  });

  it('returns null for an unbranded name so the caller can draw its own glyph', () => {
    expect(modelIconSlug('some-unknown-model')).toBeNull();
    expect(modelIconSlug('')).toBeNull();
    expect(modelIconSlug(null)).toBeNull();
  });
});
