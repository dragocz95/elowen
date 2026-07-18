#!/usr/bin/env node
/**
 * Regenerate `src/brain/modelCapabilityData.ts` from the models.dev catalog.
 *
 *   node scripts/refresh-model-capabilities.mjs                # fetch https://models.dev/api.json
 *   node scripts/refresh-model-capabilities.mjs path/to/api.json   # or read a local snapshot
 *
 * WHY a generated table: which reasoning efforts a model accepts is per (provider, model) data, not a
 * property of the model name. The same id is graded low/medium/high on one relay, high/max on another, and
 * a plain toggle on a third — so a name regex cannot be right, and guessing wrong sends an unsupported
 * `reasoning_effort` that the endpoint rejects with a 400. Only endpoints Elowen can actually address are
 * emitted, keeping the table small enough to read in a diff.
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const CATALOG_URL = 'https://models.dev/api.json';
const OUT = new URL('../src/brain/modelCapabilityData.ts', import.meta.url);

/** models.dev provider keys for the endpoints Elowen ships (src/cli/setup/constants.ts) plus the OAuth
 *  built-ins. Ollama Cloud is published as `ollama-cloud`, Moonshot as `moonshotai`, and the Kimi Code
 *  subscription as `kimi-for-coding`; the rest match our own keys 1:1 (see CATALOG_ALIAS in
 *  modelCapabilities.ts for the translation). */
const PROVIDERS = [
  'openai', 'anthropic', 'google', 'openrouter', 'xai', 'deepseek', 'groq', 'mistral', 'cerebras',
  'perplexity', 'deepinfra', 'zai', 'nvidia', 'huggingface', 'baseten', 'ollama-cloud', 'github-copilot',
  'moonshotai', 'kimi-for-coding',
];

/** Elowen's canonical effort vocabulary (CANONICAL_THINKING_LEVELS minus `off`, which is a separate
 *  toggle rather than an effort). models.dev's `none` maps onto that toggle and is dropped here. */
const CANONICAL = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const source = process.argv[2];
const catalog = source
  ? JSON.parse(await readFile(source, 'utf8'))
  : await fetch(CATALOG_URL).then((r) => {
      if (!r.ok) throw new Error(`models.dev responded ${r.status}`);
      return r.json();
    });

const entries = [];
const costs = [];
const visions = [];
for (const provider of PROVIDERS) {
  const models = catalog[provider]?.models;
  if (!models) {
    console.warn(`warn: provider "${provider}" is absent from the catalog`);
    continue;
  }
  for (const [id, model] of Object.entries(models).sort(([a], [b]) => a.localeCompare(b))) {
    // Cost is per MILLION tokens in models.dev, the same unit pi-ai's descriptor rates use, so it is
    // emitted verbatim. Recorded even when zero (a flat-rate subscription like kimi-for-coding) so a
    // direct catalog hit resolves an explicit $0 rather than falling through to an estimate.
    const c = model.cost;
    if (c && (c.input != null || c.output != null || c.cache_read != null || c.cache_write != null)) {
      costs.push([`${provider}/${id}`, [c.input ?? 0, c.output ?? 0, c.cache_read ?? 0, c.cache_write ?? 0]]);
    }
    // Vision = accepts image input. `modalities.input` is authoritative; `attachment` is the older boolean
    // flag. Recorded ONLY when the catalog actually says (true or false) — an unknown model must stay
    // absent so it keeps the conservative "declare vision, let the endpoint decide" default downstream.
    const modalInput = model.modalities?.input;
    const vision = Array.isArray(modalInput) ? modalInput.includes('image')
      : typeof model.attachment === 'boolean' ? model.attachment : undefined;
    if (vision !== undefined) visions.push([`${provider}/${id}`, vision]);
    if (!model.reasoning) { entries.push([`${provider}/${id}`, 'false']); continue; }
    const effort = (model.reasoning_options ?? []).find((option) => option.type === 'effort');
    const levels = (effort?.values ?? []).filter((value) => CANONICAL.has(value));
    // Reasoning with no graded effort (a bare on/off toggle) is `true`: the model thinks, but its effort
    // is not a settable knob — offering levels for it would advertise a parameter the endpoint rejects.
    entries.push([`${provider}/${id}`, levels.length ? `[${levels.map((l) => `'${l}'`).join(', ')}]` : 'true']);
  }
}

const body = entries.map(([key, value]) => `  '${key}': ${value},`).join('\n');
const costBody = costs.map(([key, t]) => `  '${key}': [${t.join(', ')}],`).join('\n');
const visionBody = visions.map(([key, value]) => `  '${key}': ${value},`).join('\n');
const reasoning = entries.filter(([, value]) => value !== 'false').length;
const visionCapable = visions.filter(([, value]) => value === true).length;

writeFileSync(OUT, `/* GENERATED FILE — DO NOT EDIT BY HAND.
 * Source: models.dev (${CATALOG_URL}); regenerate with \`npm run models:refresh\`.
 *
 * Which reasoning efforts an endpoint accepts, keyed \`<catalog-provider>/<model-id>\`. The value is the
 * accepted effort ladder, \`true\` for a model that reasons but exposes no effort knob (a bare toggle), or
 * \`false\` for one that does not reason at all. Consumed by descriptorCapabilities() in
 * modelCapabilities.ts, which is the only reader — a miss there falls back to name heuristics.
 *
 * ${entries.length} models, ${reasoning} of them reasoning-capable; ${costs.length} carry a price;
 * ${visions.length} declare an image-input capability (${visionCapable} accept images).
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/** Accepted effort ladder, \`true\` (reasons, effort not settable), or \`false\` (no reasoning). */
export type CatalogCapability = readonly ModelThinkingLevel[] | boolean;

/** Per-MILLION-token USD rate as \`[input, output, cacheRead, cacheWrite]\` — the same unit pi-ai's
 *  descriptor rates use, so it is consumed verbatim. A flat-rate subscription is recorded as all zeros. */
export type CatalogCost = readonly [number, number, number, number];

export const MODEL_CAPABILITY_CATALOG: Readonly<Record<string, CatalogCapability>> = {
${body}
};

export const MODEL_COST_CATALOG: Readonly<Record<string, CatalogCost>> = {
${costBody}
};

/** Whether a model accepts image input (\`modalities.input\` includes 'image', or the legacy \`attachment\`
 *  flag). Present ONLY for models the catalog is explicit about — a miss means "unknown", which downstream
 *  treats as the conservative "declare vision and let the endpoint decide" default. */
export const MODEL_VISION_CATALOG: Readonly<Record<string, boolean>> = {
${visionBody}
};
`);

console.log(`wrote ${entries.length} models (${reasoning} reasoning-capable, ${costs.length} priced, ${visions.length} with vision data) to src/brain/modelCapabilityData.ts`);
