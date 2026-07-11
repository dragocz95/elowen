import type { Model, Api, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

/**
 * Elowen's one model-capability vocabulary. PI keeps the canonical values stable while providers are
 * free to call the strongest level `xhigh`, `max`, or something else on the wire. User interfaces read
 * the labels from here instead of copying provider-specific guesses into every transport.
 */
export interface ModelCapabilityView {
  reasoning: boolean;
  levels: ModelThinkingLevel[];
  labels: Partial<Record<ModelThinkingLevel, string>>;
  /** ChatGPT OAuth's priority service tier (`service_tier: "priority"`). */
  fast: boolean;
}

/** Mutable, session-local request switches read by the provider hook for every model round-trip. */
export interface ProviderRequestProfile { fast: boolean }

/** Pure payload projection used by the Codex request hook (kept exportable for a no-network contract test). */
export function applyProviderRequestProfile(payload: Record<string, unknown>, profile: ProviderRequestProfile): Record<string, unknown> {
  return profile.fast ? { ...payload, service_tier: 'priority' } : payload;
}

type DescriptorPatch = {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  labels?: Partial<Record<ModelThinkingLevel, string>>;
  fast?: boolean;
};

export const CANONICAL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isCanonicalThinkingLevel(value: string): value is ModelThinkingLevel {
  return (CANONICAL_THINKING_LEVELS as readonly string[]).includes(value);
}

const NON_REASONING = /(?:^|[-_/])(image|embedding|embed|whisper|tts|dall-e|moderation)(?:[-_/]|$)/i;
// OpenRouter and similar catalogs namespace ids (`openai/gpt-5.6-sol`), while direct endpoints use the
// bare id. Match the actual family segment in both forms rather than keying capability to one relay.
const OPENAI_REASONING = /(?:^|\/)(?:gpt-5|o[134](?:-|$))/i;
const CLAUDE_REASONING = /(?:^|\/)claude-(?:opus|sonnet|haiku)-(?:4|5)(?:[.-]|$)/i;
const GEMINI_REASONING = /(?:^|\/)gemini-(?:2\.5|3|3\.1|3\.5)(?:-|$)/i;
const OTHER_REASONING = /(?:deepseek[-_/]?r1|qwq|reasoning)/i;

/**
 * Capability rules for descriptors Elowen creates itself (custom OpenAI-compatible endpoints and
 * OAuth catalog additions). Built-in PI descriptors remain authoritative; these rules prevent the old
 * blanket "every model supports every effort" declaration for unknown/image models.
 */
export function descriptorCapabilities(provider: string, model: string): DescriptorPatch {
  if (NON_REASONING.test(model)) return { reasoning: false };

  if (provider === 'openai-codex' || OPENAI_REASONING.test(model)) {
    const supportsMax = /(?:^|\/)gpt-5\.6(?:-|$)/i.test(model);
    return {
      reasoning: true,
      // ChatGPT Codex accepts low/medium/high/xhigh; GPT-5.6 adds the distinct `max` level. `minimal`
      // is normalized to low by the upstream catalog. The UI calls xhigh "ultra" while PI retains its
      // stable canonical id internally, leaving the stronger 5.6 level visibly named "max".
      thinkingLevelMap: {
        off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
        max: supportsMax ? 'max' : null,
      },
      labels: { xhigh: 'ultra' },
      fast: provider === 'openai-codex',
    };
  }

  if (CLAUDE_REASONING.test(model)) {
    // Anthropic's 4.6 tier adds `max`; 4.7+ (and generation 5) additionally expose xhigh. Keep the
    // two distinct instead of assuming every model with max also accepts xhigh.
    const supportsMax = /-(?:4[.-][678]|5)(?:[.-]|$)/i.test(model);
    const supportsXhigh = /-(?:4[.-][78]|5)(?:[.-]|$)/i.test(model);
    return {
      reasoning: true,
      thinkingLevelMap: {
        off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
        xhigh: supportsXhigh ? 'xhigh' : null,
        max: supportsMax ? 'max' : null,
      },
    };
  }

  if (GEMINI_REASONING.test(model) || OTHER_REASONING.test(model)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    };
  }

  // Unknown custom endpoints are conservative: advertising reasoning_effort to a plain chat model is a
  // request-breaking 400. Operators still get native metadata for every built-in OAuth model.
  return { reasoning: false };
}

/** Capability view when a custom endpoint advertised a model through `/models` but it has not been
 *  registered in PI's in-memory catalog. This keeps dynamically discovered known families useful while
 *  preserving the conservative non-reasoning result for an unknown id. */
export function inferredModelCapabilities(provider: string, model: string): ModelCapabilityView {
  const rule = descriptorCapabilities(provider, model);
  const levels = rule.reasoning
    ? CANONICAL_THINKING_LEVELS.filter((level) => {
        const mapped = rule.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
      })
    : [];
  return { reasoning: rule.reasoning, levels, labels: rule.labels ?? {}, fast: rule.fast === true };
}

/** Read-only capability view for a fully resolved model descriptor. */
export function modelCapabilities(model: Model<Api>): ModelCapabilityView {
  const inferred = inferredModelCapabilities(model.provider, model.id);
  const reasoning = !!model.reasoning;
  return {
    reasoning,
    levels: reasoning ? getSupportedThinkingLevels(model) : [],
    labels: inferred.labels,
    fast: model.provider === 'openai-codex' && model.api === 'openai-codex-responses' && !NON_REASONING.test(model.id),
  };
}

/** Accept provider-facing aliases without leaking them into PI's canonical session state. */
export function canonicalThinkingLevel(model: Model<Api>, value: string): string {
  const normalized = value.trim().toLowerCase();
  const caps = modelCapabilities(model);
  for (const level of caps.levels) {
    if ((caps.labels[level] ?? level).toLowerCase() === normalized) return level;
  }
  return normalized;
}
