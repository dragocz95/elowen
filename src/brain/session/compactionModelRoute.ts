import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

/** PI-native compaction route for one live session. The extension only identifies PI's own compaction
 * AbortSignal; the Agent's existing stream function remains the sole request executor. */
export interface CompactionModelRoute {
  extension: (pi: ExtensionAPI) => void;
  install(session: AgentSession): void;
}

/**
 * Route PI's own compaction request through a distinct, already-resolved model — the user's chosen
 * compaction model or a provider's stable default. That model may live on a DIFFERENT provider than the
 * chat session (e.g. chat on Claude, summarize on a cheaper Kimi/Qwen).
 *
 * `session_before_compact` cannot safely perform the request itself: ExtensionRunner deliberately catches
 * handler errors, after which AgentSession falls through to its native `compact()` and issues a second
 * request. Instead, this marker returns no custom result. AgentSession therefore retains its complete
 * native flow (`fromExtension=false`, file-operation details, persistence, overflow retry), while the
 * wrapper substitutes the model only for stream calls carrying that exact compaction signal.
 */
export function createCompactionModelRoute(
  fallbackModel?: Model<Api>,
): CompactionModelRoute | undefined {
  if (!fallbackModel) return undefined;

  const compactionSignals = new WeakSet<AbortSignal>();
  const installed = new WeakSet<AgentSession['agent']>();

  return {
    extension(pi) {
      pi.on('session_before_compact', (event) => {
        compactionSignals.add(event.signal);
        // Undefined is intentional: PI must execute and persist the compaction itself.
        return undefined;
      });
    },

    install(session) {
      const agent = session.agent;
      if (installed.has(agent)) return;
      installed.add(agent);
      const nativeStream = agent.streamFunction;
      agent.streamFunction = (model, context, options) => {
        const signal = options?.signal;
        const isNativeCompaction = signal !== undefined && compactionSignals.has(signal);
        if (!isNativeCompaction) return nativeStream(model, context, options);
        // Same provider: reuse the session's already-resolved auth/headers/env (preserves ChatGPT OAuth
        // tokens, account headers, etc.) exactly as before.
        if (fallbackModel.provider === model.provider) return nativeStream(fallbackModel, context, options);
        // Cross-provider: PI pre-resolved `apiKey`/`headers`/`env` for the CHAT provider (via
        // _getSummarizationRequestAuth on the session model); passing them to the fallback's endpoint would
        // override its own auth and 401. Strip them so ModelRuntime resolves the fallback provider's own
        // credentials (inline key or stored OAuth with refresh) — the exact path a normal chat turn on that
        // provider uses. `reasoning` still rides along; the fallback model clamps/ignores it per its own
        // descriptor, matching every other cross-model thinking-level pass.
        return nativeStream(fallbackModel, context, { ...options, apiKey: undefined, headers: undefined, env: undefined });
      };
    },
  };
}
