import { MODEL_ICON_SLUGS } from './modelIconSlugs';

// Ordered keyword → lobe-icons base slug. First match wins, so put the model brand
// (deepseek, kimi…) before the runner brand (ollama) — `ollama/deepseek-…` is a DeepSeek model.
const RULES: [RegExp, string][] = [
  [/deepseek/i, 'deepseek'],
  [/claude[\s_-]?code|claudecode/i, 'claudecode'],
  [/claude|anthropic|sonnet|opus|haiku/i, 'claude'],
  [/codex/i, 'codex'],
  [/gpt|openai|chatgpt|\bo[1-4]\b/i, 'openai'],
  [/kimi|\bk2\b/i, 'kimi'],
  [/moonshot/i, 'moonshot'],
  [/minimax/i, 'minimax'],
  [/qwen|qwq/i, 'qwen'],
  [/gemini/i, 'gemini'],
  [/mistral|mixtral|codestral|magistral|devstral/i, 'mistral'],
  [/grok/i, 'grok'],
  [/\bxai\b/i, 'xai'],
  [/glm|chatglm|zhipu/i, 'zhipu'],
  [/llama|meta[\s_-]?ai|\bmeta\b/i, 'metaai'],
  [/ollama/i, 'ollama'],
];

/** Best lobe-icons slug for a model identifier (exec string / label / name), or null.
 *  Prefers the brand-colored `-color` variant; falls back to the mono base (currentColor). */
export function modelIconSlug(name: string | undefined | null): { slug: string; color: boolean } | null {
  if (!name) return null;
  for (const [re, base] of RULES) {
    if (re.test(name)) {
      const colorSlug = `${base}-color`;
      if (MODEL_ICON_SLUGS.has(colorSlug)) return { slug: colorSlug, color: true };
      if (MODEL_ICON_SLUGS.has(base)) return { slug: base, color: false };
    }
  }
  return null;
}
