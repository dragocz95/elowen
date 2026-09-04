import { MODEL_ICON_SLUGS } from './modelIconSlugs';

// Ordered keyword → lobe-icons base slug. First match wins, so put the model brand
// (deepseek, kimi…) before the runner brand (ollama) — `ollama/deepseek-…` is a DeepSeek model.
const RULES: [RegExp, string][] = [
  [/deepseek/i, 'deepseek'],
  [/claude[\s_-]?code|claudecode/i, 'claudecode'],
  [/claude|anthropic|sonnet|opus|haiku/i, 'claude'],
  [/codex/i, 'codex'],
  [/gpt|openai|chatgpt|\bo[1-4]\b/i, 'openai'],
  // The Kimi Code endpoint names its models `k3` / `k2p7` and says "kimi" nowhere, so the brand has to be
  // recognised from the bare id too. Anchored to a whole segment: a loose `k\d` would brand half the
  // catalog. `k2p7` also defeats `\bk2\b` — the `p` leaves no word boundary — hence the explicit shape.
  [/kimi|\bk2\b|(?:^|\/)k\d+(?:p\d+)?$/i, 'kimi'],
  [/moonshot/i, 'moonshot'],
  [/minimax/i, 'minimax'],
  [/qwen|qwq/i, 'qwen'],
  [/gemini/i, 'gemini'],
  [/mistral|mixtral|codestral|magistral|devstral/i, 'mistral'],
  [/grok/i, 'grok'],
  [/\bxai\b/i, 'xai'],
  [/xiaomi|mimo/i, 'xiaomimimo'],
  // Z.ai — Zhipu's international brand — carries its OWN lobe mark, distinct from the GLM models Zhipu
  // serves, and it is mono-only. Matched whole-word, so a label like `Z.ai` or an id `zai` brands while
  // `myz.ai` or a model containing "zai" mid-word stays untouched.
  [/\bz\.?ai\b/i, 'zai'],
  [/glm|chatglm|zhipu/i, 'zhipu'],
  [/llama|meta[\s_-]?ai|\bmeta\b/i, 'metaai'],
  [/ollama/i, 'ollama'],
  // Runner brands, and therefore last: `github-copilot/claude-opus-4.8` is a CLAUDE model that happens to
  // be served through Copilot, so the Claude rule above must win. Only a bare "copilot" — the account row
  // itself, which has no model — falls this far. Note the slug: `copilot-color` is Microsoft Copilot, a
  // different product; GitHub's own mark is `githubcopilot` (mono only, so ModelIcon inverts it).
  [/github[\s_-]?copilot|\bcopilot\b/i, 'githubcopilot'],
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
