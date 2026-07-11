import { compact } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

const CODEX_COMPACTION_FALLBACK_MODEL = 'gpt-5.5';

interface CodexCompactionFallbackOptions {
  model: Model<Api>;
  registry: Pick<ModelRegistry, 'find' | 'getApiKeyAndHeaders'>;
  preparation: Parameters<typeof compact>[0];
  customInstructions?: string;
  signal?: AbortSignal;
  compactFn?: typeof compact;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function runCompaction(
  o: CodexCompactionFallbackOptions,
  model: Model<Api>,
): Promise<Awaited<ReturnType<typeof compact>>> {
  const auth = await o.registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  return (o.compactFn ?? compact)(
    o.preparation, model, auth.apiKey, auth.headers, o.customInstructions, o.signal,
    undefined, undefined, auth.env,
  );
}

/** ChatGPT can occasionally resolve a preview Codex model to an internal deployment slug that is no
 * longer registered for standalone summary requests. Keep the chosen model for normal chat and try it
 * first for compaction; only the provider's explicit Model-not-found response retries the exact same PI
 * compaction through the stable OAuth gpt-5.5 descriptor. Other failures remain visible and untouched. */
export async function compactCodexWithModelFallback(
  o: CodexCompactionFallbackOptions,
): Promise<Awaited<ReturnType<typeof compact>>> {
  try {
    return await runCompaction(o, o.model);
  } catch (error) {
    if (!/\bmodel not found\b/i.test(errorText(error)) || o.model.id === CODEX_COMPACTION_FALLBACK_MODEL) throw error;
    const fallback = o.registry.find('openai-codex', CODEX_COMPACTION_FALLBACK_MODEL);
    if (!fallback) throw error;
    try {
      return await runCompaction(o, fallback);
    } catch (fallbackError) {
      throw new Error(`Codex compaction fallback failed after ${errorText(error)}: ${errorText(fallbackError)}`, { cause: fallbackError });
    }
  }
}

/** Inline PI extension used only for Codex preview models. Returning a CompactionResult keeps PI's own
 * cut-point, persistence and retry lifecycle intact; this changes model routing, not compaction format. */
export function codexCompactionModelFallback(pi: ExtensionAPI): void {
  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== 'openai-codex' || model.id === CODEX_COMPACTION_FALLBACK_MODEL) return undefined;
    const compaction = await compactCodexWithModelFallback({
      model, registry: ctx.modelRegistry, preparation: event.preparation,
      customInstructions: event.customInstructions, signal: event.signal,
    });
    return { compaction };
  });
}
