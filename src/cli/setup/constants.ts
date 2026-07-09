import type { BrainProviderType } from '../../store/configStore.js';

/** OpenAI-compatible chat/embeddings base — includes the `/v1` version segment the openai client needs. */
const OPENAI_BASE = 'https://api.openai.com/v1';
/** Anthropic Messages API base — NO `/v1` (the anthropic-messages client appends its own path). */
const ANTHROPIC_BASE = 'https://api.anthropic.com';
/** OpenRouter's OpenAI-compatible base. */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/** Local Ollama's OpenAI-compatible endpoint — served by a self-hosted `ollama serve` on the same host
 *  as the daemon. No API key. The dedicated "Self-hosted (local Ollama)" wizard choice installs Ollama
 *  and pulls a model before pointing a keyless `openai`-type provider here. */
// 127.0.0.1 (not `localhost`): Ollama binds the IPv4 loopback, and on hosts where `localhost` resolves to
// ::1 first a `localhost` base would probe-pass in the wizard yet fail the saved provider at runtime.
export const OLLAMA_LOCAL_BASE = 'http://127.0.0.1:11434/v1';

/** Recommended embedding model — small, cheap, widely served on OpenAI-compatible endpoints. */
export const RECOMMENDED_EMBEDDING_MODEL = 'text-embedding-3-small';

/** API-key provider presets for the AI step: label + brain provider type + default base URL. Base URLs
 *  are the OpenAI-compatible (or Anthropic Messages) endpoints; the openai client appends
 *  `/chat/completions`, so every `openai`-type base includes its version segment. Curated to mirror the
 *  common providers users are likely to hold a key for — pick "Custom OpenAI-compatible endpoint" for
 *  anything else. */
export const API_KEY_PROVIDERS: { key: string; label: string; type: BrainProviderType; base: string }[] = [
  { key: 'coresynth', label: 'CoreSynth AI', type: 'openai', base: 'https://ai.coresynth.io/v1' },
  { key: 'openai', label: 'OpenAI', type: 'openai', base: OPENAI_BASE },
  { key: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', base: ANTHROPIC_BASE },
  { key: 'openrouter', label: 'OpenRouter', type: 'openai', base: OPENROUTER_BASE },
  { key: 'google', label: 'Google Gemini', type: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { key: 'xai', label: 'xAI (Grok)', type: 'openai', base: 'https://api.x.ai/v1' },
  { key: 'deepseek', label: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com/v1' },
  { key: 'groq', label: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1' },
  { key: 'mistral', label: 'Mistral', type: 'openai', base: 'https://api.mistral.ai/v1' },
  { key: 'together', label: 'Together AI', type: 'openai', base: 'https://api.together.xyz/v1' },
  { key: 'fireworks', label: 'Fireworks AI', type: 'openai', base: 'https://api.fireworks.ai/inference/v1' },
  { key: 'cerebras', label: 'Cerebras', type: 'openai', base: 'https://api.cerebras.ai/v1' },
  { key: 'perplexity', label: 'Perplexity', type: 'openai', base: 'https://api.perplexity.ai' },
  { key: 'deepinfra', label: 'DeepInfra', type: 'openai', base: 'https://api.deepinfra.com/v1/openai' },
  { key: 'moonshot', label: 'Moonshot (Kimi)', type: 'openai', base: 'https://api.moonshot.ai/v1' },
  { key: 'zai', label: 'Z.AI (GLM)', type: 'openai', base: 'https://api.z.ai/api/paas/v4' },
  { key: 'nvidia', label: 'NVIDIA NIM', type: 'openai', base: 'https://integrate.api.nvidia.com/v1' },
  { key: 'huggingface', label: 'Hugging Face', type: 'openai', base: 'https://router.huggingface.co/v1' },
  { key: 'baseten', label: 'Baseten', type: 'openai', base: 'https://inference.baseten.co/v1' },
  { key: 'ollama', label: 'Ollama Cloud', type: 'openai', base: 'https://ollama.com/v1' },
  { key: 'ollama-local', label: 'Ollama (local)', type: 'openai', base: OLLAMA_LOCAL_BASE },
];

/** OAuth sign-in choices → the brain provider config `type` + the pi-ai built-in name (for the catalog). */
export const OAUTH_CHOICES: { type: BrainProviderType; label: string; builtin: string }[] = [
  { type: 'oauth-openai-codex', label: 'Sign in with Codex / OpenAI', builtin: 'openai-codex' },
  { type: 'oauth-anthropic', label: 'Sign in with Claude', builtin: 'anthropic' },
  { type: 'oauth-github-copilot', label: 'Sign in with GitHub Copilot', builtin: 'github-copilot' },
];
