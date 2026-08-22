import { streamSSE } from 'hono/streaming';
import type { BrainEvent } from '../../brain/events.js';
import { brainEventReplayCursor, withoutBrainEventReplayCursor } from '../../brain/session/liveEventReplay.js';
import { SerializedEventBuffer } from '../../brain/session/serializedEventBuffer.js';
import type { ElowenApp } from '../context.js';
import { messagePageOpts, type BrainRouteContext } from './brainRouteContext.js';

export function registerBrainStreamRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d, forbidden } = route;
  // Live events of the ACTIVE conversation by default, or of one explicitly owned session when
  // `?session=<id>` is given (the sub-agent drill-in stream — survives that session's respawns).
  app.get('/brain/stream', c => {
    if (!d.brain) return c.json({ error: 'brain unavailable' }, 503);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const brain = d.brain;
    const userId = c.get('user').id;
    const session = c.req.query('session');
    const rawClientId = c.req.query('client');
    if (rawClientId !== undefined && (rawClientId.length === 0 || rawClientId.length > 200)) {
      return c.json({ error: 'invalid client id' }, 400);
    }
    // Authentication is already complete at this point; lifecycle scopes the opaque client id by this
    // userId, so another account can never detach or stop this caller's attachment.
    const clientId = rawClientId;
    const rawClientGeneration = c.req.query('generation');
    const clientGeneration = rawClientGeneration === undefined ? undefined : Number(rawClientGeneration);
    if (clientGeneration !== undefined
      && (!Number.isSafeInteger(clientGeneration) || clientGeneration <= 0 || !clientId)) {
      return c.json({ error: 'invalid client generation' }, 400);
    }
    // Explicit opt-in: normal parent/web streams keep their existing non-replaying contract. Drill-in
    // clients request one replace-in-place snapshot so reconnecting never appends duplicate deltas.
    const withSnapshot = !!session && c.req.query('snapshot') === '1';
    // The snapshot's history is windowed only for a client that asked for a page (`?history=<n>`, the web
    // chat's lazy-load). Without it the frame keeps carrying the full transcript — the CLI's contract.
    const historyWindow = withSnapshot ? messagePageOpts(c.req.query('history')) : undefined;
    return streamSSE(c, async stream => {
      let off: (() => void) | null = null;
      let ready = !withSnapshot;
      const pending = new SerializedEventBuffer<BrainEvent>();
      let pendingOverflow = false;
      let overflowClose: Promise<void> | null = null;
      let writes = Promise.resolve();
      const unsubscribe = (): void => {
        const dispose = off;
        off = null;
        dispose?.();
      };
      const closeOverflow = (): Promise<void> => {
        c.req.raw.signal.removeEventListener('abort', unsubscribe);
        unsubscribe();
        overflowClose ??= stream.close();
        return overflowClose;
      };
      const writeEvent = (e: BrainEvent): void => {
        const cursor = brainEventReplayCursor(e);
        // Replay identity travels in SSE's standard `id` field, not in the public BrainEvent JSON. That
        // keeps Discord/plugin consumers and existing JSONL clients on the stable event schema while a
        // reconnecting CLI can still distinguish an already seen coalesced delta from a new one.
        writes = writes.then(() => stream.writeSSE({
          data: JSON.stringify(withoutBrainEventReplayCursor(e)), event: e.type,
          ...(cursor !== undefined ? { id: String(cursor) } : {}),
        })).catch(() => undefined);
      };
      const deliver = (e: BrainEvent): void => {
        if (!ready) {
          // The first snapshot is useful only with its COMPLETE post-capture replay. On either raw-event
          // or serialized UTF-8 overflow, unsubscribe and close: the reconnect will obtain a new atomic
          // snapshot instead of treating a retained suffix as complete state.
          if (pending.append(e) === 'overflow' && !pendingOverflow) {
            pendingOverflow = true;
            void closeOverflow();
          }
          return;
        }
        writeEvent(e);
      };
      let snapshot: Awaited<ReturnType<typeof brain.tapSessionSnapshot>>['snapshot'] | null = null;
      try {
        if (session && withSnapshot) {
          // An admin may READ a foreign conversation (the cross-account register opens it read-only).
          // The write paths are untouched: /brain/send keeps its own ownership check, so this can only
          // ever show history, never post into someone else's conversation.
          const anyOwner = !!c.get('user')?.is_admin;
          const attached = await brain.tapSessionSnapshot(userId, session, deliver, clientId, clientGeneration, historyWindow, { anyOwner });
          off = attached.off;
          snapshot = attached.snapshot;
        } else off = session
          ? brain.tapSession(userId, session, deliver, clientId, clientGeneration)
          : brain.subscribe(userId, deliver, clientId, clientGeneration);
      }
      catch { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: session ? 'unknown session' : 'brain not started' }), event: 'error' }); return; }
      // Remote runner taps attach asynchronously. The client may disconnect before that IPC round-trip
      // completes, so consume an already-fired abort before registering the ordinary close listener.
      if (c.req.raw.signal.aborted) { unsubscribe(); return; }
      c.req.raw.signal.addEventListener('abort', unsubscribe, { once: true });
      if (pendingOverflow) {
        await closeOverflow();
        return;
      }
      if (snapshot) {
        writes = writes.then(() => stream.writeSSE({
          data: JSON.stringify(snapshot), event: 'snapshot', id: String(snapshot.cursor),
        })).catch(() => undefined);
        await writes;
        if (pendingOverflow) {
          await closeOverflow();
          return;
        }
        ready = true;
        for (const event of pending.drain()) writeEvent(event);
        await writes;
      }
      // Comment flush so the channel connects through the BFF proxy on a quiet system (see /events).
      await stream.write(': connected\n\n');
      // An SSE comment line never surfaces in an EventSource, so `: ping` is invisible to a browser client
      // and cannot carry a silence watchdog. `?heartbeat=1` upgrades the keep-alive to a named frame the
      // client CAN observe; it stays opt-in so CLI, Discord and JSONL consumers keep reading a stream whose
      // events are only ever BrainEvent types.
      const namedHeartbeat = c.req.query('heartbeat') === '1';
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(30000);
        if (c.req.raw.signal.aborted) break;
        if (!namedHeartbeat) { await stream.write(': ping\n\n'); continue; }
        writes = writes.then(() => stream.writeSSE({ data: '{}', event: 'heartbeat' })).catch(() => undefined);
        await writes;
      }
    });
  });
}
