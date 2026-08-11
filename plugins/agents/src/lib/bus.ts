import type { ElowenEvent } from '../../../../src/api/sse.js';
import type { SignalSink } from '../../../../src/shared/agentEvents.js';

/** Structural view of the core EventBus as this subsystem uses it. The copies alias it back to
 *  `EventBus` so their bodies stay byte-close to the originals, but the STRUCTURAL type is what lets
 *  the composition root hand in an adapter built from ctx.publishEvent/ctx.subscribeEvents — the core
 *  EventBus class carries a private field, so its nominal type is unsatisfiable from outside core. */
export interface AgentsBus {
  publish(e: ElowenEvent): void;
  subscribe(fn: (e: ElowenEvent) => void): () => void;
}

/** The full bus adapter shape the runtime builds: AgentsBus for the copies + SignalSink for the
 *  deriver (`emit` wraps a signal into the `signal` event exactly like the core EventBus does). */
export type AgentsBusWithSink = AgentsBus & SignalSink;
