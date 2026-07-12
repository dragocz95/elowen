import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

/** PI-native compaction route for one live Codex session. The extension only identifies PI's own
 * compaction AbortSignal; the Agent's existing stream function remains the sole request executor. */
export interface CodexCompactionModelRoute {
  extension: (pi: ExtensionAPI) => void;
  install(session: AgentSession): void;
}

/**
 * Route PI's own compaction request through a distinct, already-resolved same-provider model.
 *
 * `session_before_compact` cannot safely perform the request itself: ExtensionRunner deliberately catches
 * handler errors, after which AgentSession falls through to its native `compact()` and issues a second
 * request. Instead, this marker returns no custom result. AgentSession therefore retains its complete
 * native flow (`fromExtension=false`, file-operation details, persistence, overflow retry), while the
 * wrapper substitutes the model only for stream calls carrying that exact compaction signal.
 */
export function createCodexCompactionModelRoute(
  fallbackModel?: Model<Api>,
): CodexCompactionModelRoute | undefined {
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
      const nativeStream = agent.streamFn;
      agent.streamFn = (model, context, options) => {
        const signal = options?.signal;
        const isNativeCompaction = signal !== undefined && compactionSignals.has(signal);
        const routed = isNativeCompaction && model.provider === fallbackModel.provider
          ? fallbackModel
          : model;
        // Preserve the native SDK stream pipeline and the exact PI-owned context/options object. It
        // continues to resolve auth, headers, env, retry limits, timeout and transport for `routed`.
        return nativeStream(routed, context, options);
      };
    },
  };
}
