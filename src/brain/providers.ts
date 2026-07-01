import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';

export interface BrainEndpointConfig { baseUrl?: string; apiKey: string; model: string }
export interface BrainProviderConfig {
  openai?: BrainEndpointConfig;
  anthropic?: BrainEndpointConfig;
  default: 'openai' | 'anthropic';
}

/** Provider ids the brain registers under. Stable so resolveBrainModel can look them up. */
const OPENAI_PROVIDER = 'orca-openai';
const ANTHROPIC_PROVIDER = 'orca-anthropic';

/** Normalize an OpenAI-compatible base so we never double up the `/v1` the client re-appends. */
const normOpenAiBase = (base: string) => base.replace(/\/v1\/?$/, '');

/** Reasonable descriptor defaults — the brain is a chat agent, exact cost/window are not load-bearing
 *  here (usage accounting lives elsewhere), so we ship safe placeholders the model list requires. */
function modelEntry(id: string) {
  return {
    id, name: id, reasoning: true, input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000, maxTokens: 8_192,
  };
}

/** Build an in-memory ModelRegistry with the two Orca brain providers registered from Orca config.
 *  API keys are passed inline (no models.json / disk). pi-ai owns the streaming per model.api. */
export function buildBrainRegistry(cfg: BrainProviderConfig): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  if (cfg.openai) {
    registry.registerProvider(OPENAI_PROVIDER, {
      name: 'Orca OpenAI-compatible',
      api: 'openai-completions',
      baseUrl: normOpenAiBase(cfg.openai.baseUrl ?? 'https://api.openai.com'),
      apiKey: cfg.openai.apiKey,
      models: [modelEntry(cfg.openai.model)],
    });
  }
  if (cfg.anthropic) {
    registry.registerProvider(ANTHROPIC_PROVIDER, {
      name: 'Orca Anthropic',
      api: 'anthropic-messages',
      baseUrl: cfg.anthropic.baseUrl ?? 'https://api.anthropic.com',
      apiKey: cfg.anthropic.apiKey,
      models: [modelEntry(cfg.anthropic.model)],
    });
  }
  return registry;
}

/** Resolve the configured Model for the chosen provider (defaults to cfg.default). Throws a clear
 *  error if that provider was not configured — the caller surfaces it to the user. */
export function resolveBrainModel(
  registry: ModelRegistry, cfg: BrainProviderConfig, which: 'openai' | 'anthropic' = cfg.default,
): Model<Api> {
  const provider = which === 'anthropic' ? ANTHROPIC_PROVIDER : OPENAI_PROVIDER;
  const modelId = which === 'anthropic' ? cfg.anthropic?.model : cfg.openai?.model;
  if (!modelId) throw new Error(`brain provider '${which}' is not configured`);
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`brain model '${modelId}' not found for provider '${which}'`);
  return model;
}
