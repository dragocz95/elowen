import { contentText } from '@earendil-works/pi-ai';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { InferenceClient } from '../inference/types.js';
import { buildBrainRegistry, registryProviderName, type BrainRuntimeConfig } from './providers.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** One bounded background completion must not hold a generation slot forever: a hosted reasoning model
 *  can legitimately think for a while, but past this the run counts as failed and the caller's retry
 *  rules take over. */
const COMPLETION_TIMEOUT_MS = 180_000;

/** Background one-shot inference through the SAME stack the brain's conversations run on.
 *
 *  The homegrown RelayClient can only speak bearer-key Chat Completions, which locks background
 *  features (dashboard digest) out of every OAuth account — Claude and Codex talk their own dialects
 *  with their own auth flows. `ModelRuntime.completeSimple` already implements all of that, token
 *  refresh included, so this adapter resolves the configured route against the brain's provider
 *  registry and runs ONE completion. No session, no persistence, no conversation — the same contract
 *  the RelayClient path had, minus its auth ceiling.
 *
 *  The runtime is shared with live conversations on purpose: registering providers twice composes
 *  idempotently, and a second runtime would need its own credential store and catalog. */
export function piInferenceClient(deps: {
  runtime: ModelRuntime;
  config: () => BrainRuntimeConfig | null;
  route: () => { providerId: string; model: string } | null;
}): InferenceClient | null {
  const route = deps.route();
  if (!route) return null;
  const cfg = deps.config();
  if (!cfg) return null; // no providers configured at all — nothing to authenticate with
  const entry = cfg.providers.find((p) => p.id === route.providerId);
  if (!entry) return null;
  // Sync the registry so a custom endpoint added in Settings resolves before any conversation ran.
  // For built-in OAuth providers this also extends the catalog (Opus 5, Codex models) and applies
  // pinned windows — identical to what a session spawn would have done.
  buildBrainRegistry(cfg, deps.runtime);
  const model = deps.runtime.getModel(registryProviderName(entry), route.model) as Model<Api> | undefined;
  if (!model) return null;

  return {
    model: `${route.providerId}/${route.model}`,
    async decide(prompt: string, opts?: { signal?: AbortSignal }) {
      const context: Context = { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] };
      const deadline = AbortSignal.timeout(COMPLETION_TIMEOUT_MS);
      const message = await deps.runtime.completeSimple(model, context, {
        // Whichever fires first. A caller with a user waiting on the answer can impose a shorter
        // deadline than this background ceiling, but never a longer one.
        signal: opts?.signal ? AbortSignal.any([deadline, opts.signal]) : deadline,
      });
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(message.errorMessage || `completion ${message.stopReason}`);
      }
      // Thinking blocks and tool calls (a hosted model should produce none — no tools are offered)
      // are dropped; only the answer text matters to a JSON-reply consumer. Usage remains host metadata
      // so plugin-triggered secondary inference can join the write-time origin rollup without persistence.
      const usage = message.usage;
      return {
        text: contentText(message.content.filter((c) => c.type === 'text')),
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens,
          cost: Number.isFinite(usage.cost.total) ? usage.cost.total : null,
        },
      };
    },
  };
}
