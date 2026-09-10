'use client';

/** The typed side of the generic `plugin` SSE event.
 *
 *  `useElowenEvents` already receives every plugin event and invalidates the react-query cache from it,
 *  which is the right answer for data a query owns. It is the wrong answer for a payload nobody queries:
 *  a lifecycle operation's progress is pushed, not fetched, and turning it into an invalidation would put
 *  the polling back that the push exists to remove. So the same handler also hands the parsed event to
 *  the subscribers here, and a surface that wants the payload reads it instead of asking for it again.
 *
 *  Deliberately a plain module emitter rather than a context: the SSE connection is a singleton owned by
 *  the shell, subscribers come and go with individual dialogs, and a provider would only add a tree the
 *  plugin bundles cannot reach anyway. */
export interface PluginEvent {
  type: 'plugin';
  plugin: string;
  kind: string;
  projectId: number | null;
  data: unknown;
}

const subscribers = new Set<(event: PluginEvent) => void>();

export function subscribePluginEvents(fn: (event: PluginEvent) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Fan out one parsed plugin event. A throwing subscriber is isolated: a dialog that unmounted mid-flight
 *  must not silence the event for everything else listening. */
export function emitPluginEvent(event: PluginEvent): void {
  for (const fn of [...subscribers]) {
    try { fn(event); } catch { /* one dead subscriber never stops the fan-out */ }
  }
}

export function isPluginEvent(value: unknown): value is PluginEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.type === 'plugin' && typeof event.plugin === 'string' && typeof event.kind === 'string';
}
