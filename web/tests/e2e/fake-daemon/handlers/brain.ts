// The brain endpoints the chat surface polls on mount, the turn-accepting `POST /brain/send`, and the
// scriptable `GET /brain/stream` SSE endpoint. The stream is registered in the shared registry so the
// control channel can push scripted BrainEvent frames into it; only the nondeterministic agent output
// is faked — the real cookie/BFF/EventSource/reducer pipeline is exercised end to end.
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  brainStatus,
  brainSessions,
  brainModels,
  brainCommands,
  brainMessages,
  DEFAULT_SESSION_ID,
} from '../../seed/fixtures.ts';
import type { BrainMessage } from '../../../../lib/types.ts';
import { registerStream, unregisterStream, emitToStreams } from '../streams.ts';
import { sseFrame, idleEvent } from '../emitters.ts';
import { getResponse, getMessages } from '../overrides.ts';

/** One turn accepted by `POST /brain/send`, recorded so a test can assert what the UI sent upstream. */
export interface RecordedSend {
  text: string;
  session?: string;
  client?: string;
  generation?: number;
  mode?: string;
  at: number;
}

/** A non-send control call the UI posts (the /model picker, the Stop button), recorded so a spec can
 *  assert the exact payload the web sent upstream — exposed via `GET /__test/calls`. */
export type RecordedCall =
  | { kind: 'model'; provider?: string; model?: string; session?: string; at: number }
  | { kind: 'abort'; session?: string; client?: string; at: number };

const recordedSends: RecordedSend[] = [];
const recordedCalls: RecordedCall[] = [];

/** The model each session was last switched to via `POST /brain/model`, so `GET /brain/status` reports it
 *  afterwards — mirroring the real route, which respawns the session in place under the new model. Keyed by
 *  the session id the switch targeted (defaulting to the active conversation). */
const modelBySession = new Map<string, string>();

/** Durable `model → X` markers a `POST /brain/model` switch persisted into the transcript, keyed by session.
 *  The real route writes a display marker into history AND pushes a `session-event`; every attached client
 *  reconciles by refetching history, which then renders the marker. The fake mirrors that: `GET /brain/messages`
 *  appends these (newest-last) so the post-switch reload shows the marker, exactly like the real reload. */
const markersBySession = new Map<string, BrainMessage[]>();

/** Read-only view of the turns the UI has posted so far (exposed via `GET /__test/sent`). */
export function sentTurns(): readonly RecordedSend[] {
  return recordedSends;
}

/** Read-only view of the recorded control calls (model switch / abort), for `GET /__test/calls`. */
export function recordedControlCalls(): readonly RecordedCall[] {
  return recordedCalls;
}

/** Clear the recorded turns + control calls + per-session model overrides (the control channel's
 *  `/__test/reset`), so each test starts from the seed defaults. */
export function resetSentTurns(): void {
  recordedSends.length = 0;
  recordedCalls.length = 0;
  modelBySession.clear();
  markersBySession.clear();
}

/** Serve a backwards page of history (the chat lazy-load): the newest `limit` turns, then older ones as
 *  `before` (a previous page's `nextBefore`, an exclusive index cursor) walks back through the seed. */
function messagesPage(source: readonly BrainMessage[], limit: number, before?: number): { items: BrainMessage[]; hasMore: boolean; nextBefore: number | null } {
  const end = before === undefined ? source.length : Math.max(0, Math.min(before, source.length));
  const start = Math.max(0, end - limit);
  const items = source.slice(start, end);
  const hasMore = start > 0;
  return { items, hasMore, nextBefore: hasMore ? start : null };
}

export function registerBrainRoutes(app: Hono): void {
  app.get('/brain/status', (c) => {
    const session = c.req.query('session');
    const base = getResponse('brain/status', brainStatus);
    // Reflect an earlier `POST /brain/model` switch: a client reconciling after the `session-event` refetches
    // status and must see the new model (exactly what makes a passive watcher's picker label move).
    const key = session ?? base.sessionId ?? DEFAULT_SESSION_ID;
    const switched = modelBySession.get(key);
    return c.json({ ...base, ...(switched ? { model: switched } : {}), ...(session ? { sessionId: session } : {}) });
  });

  app.get('/brain/sessions', (c) => c.json(getResponse('brain/sessions', brainSessions)));
  app.get('/brain/models', (c) => c.json(getResponse('brain/models', brainModels)));
  app.get('/brain/commands', (c) => c.json(getResponse('brain/commands', { commands: brainCommands })));

  app.get('/brain/messages', (c) => {
    const session = c.req.query('session') ?? DEFAULT_SESSION_ID;
    // Overlay any `model → X` markers a switch persisted for this session (newest-last), so a client
    // reloading history after the `session-event` renders them — the in-place-respawn marker contract.
    const markers = markersBySession.get(session) ?? [];
    const source = markers.length ? [...getMessages(brainMessages), ...markers] : getMessages(brainMessages);
    const rawLimit = c.req.query('limit');
    if (rawLimit === undefined) return c.json(source);
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) return c.json(source);
    const rawBefore = c.req.query('before');
    const before = rawBefore === undefined ? undefined : Number(rawBefore);
    return c.json(messagesPage(source, Math.floor(limit), before !== undefined && Number.isFinite(before) ? Math.floor(before) : undefined));
  });

  app.post('/brain/start', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { session?: unknown; fresh?: unknown };
    const sessionId =
      typeof body.session === 'string' && body.session
        ? body.session
        : body.fresh === true
          ? `brain-fresh-${Date.now()}`
          : DEFAULT_SESSION_ID;
    return c.json({ sessionId }, 201);
  });

  app.post('/brain/send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown;
      session?: unknown;
      client?: unknown;
      generation?: unknown;
      mode?: unknown;
    };
    recordedSends.push({
      text: typeof body.text === 'string' ? body.text : '',
      session: typeof body.session === 'string' ? body.session : undefined,
      client: typeof body.client === 'string' ? body.client : undefined,
      generation: typeof body.generation === 'number' ? body.generation : undefined,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
      at: Date.now(),
    });
    return c.json({ ok: true, accepted: true }, 202);
  });

  // Switch the caller's conversation to another model (the /model picker). Mirrors the real route's
  // observable effects: it records the call, remembers the new model so subsequent `GET /brain/status`
  // reports it, and pushes a `session-event` into every open stream of that session — the frame every
  // attached client folds to refetch history+status WITHOUT reconnecting (the in-place respawn contract).
  app.post('/brain/model', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { provider?: unknown; model?: unknown; session?: unknown };
    const provider = typeof body.provider === 'string' ? body.provider : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const session = typeof body.session === 'string' ? body.session : undefined;
    recordedCalls.push({ kind: 'model', provider, model, session, at: Date.now() });
    const key = session ?? DEFAULT_SESSION_ID;
    if (model) {
      modelBySession.set(key, model);
      // Persist the display marker the reload will render (mirrors the real route writing it to history).
      // `detail` is the bare model id; the surface's `eventLabel` renders it as "model → <id>".
      const markers = markersBySession.get(key) ?? [];
      markers.push({ id: `mk-${Date.now()}`, role: 'event', text: '', kind: 'model', detail: model });
      markersBySession.set(key, markers);
    }
    // Broadcast to the session's streams so every attached client (initiator + passive watchers) reconciles.
    await emitToStreams({ session: key }, {
      type: 'session-event',
      id: `se-${Date.now()}`,
      kind: 'model',
      detail: `model → ${model ?? ''}`,
      at: new Date().toISOString(),
    });
    return c.json({ model: model ?? modelBySession.get(key) ?? brainStatus.model });
  });

  // Stop the streaming turn (the chat Stop button). The real route aborts the run, which drives the turn to
  // its terminal `idle` for EVERY watcher of the session — so record the call and push `idle` into the
  // session's streams, settling busy on every attached client (the multi-client abort contract).
  app.post('/brain/abort', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { session?: unknown; client?: unknown };
    const session = typeof body.session === 'string' ? body.session : undefined;
    const client = typeof body.client === 'string' ? body.client : undefined;
    recordedCalls.push({ kind: 'abort', session, client, at: Date.now() });
    await emitToStreams({ session: session ?? DEFAULT_SESSION_ID }, idleEvent());
    return c.json({ ok: true });
  });

  // Scriptable live stream. Registers the open connection keyed by client+session; the control channel
  // writes scripted frames into it. Honors `snapshot=1` with a minimal snapshot frame, then keeps the
  // connection open (heartbeat comments) until the client disconnects.
  app.get('/brain/stream', (c) => {
    const session = c.req.query('session');
    const client = c.req.query('client');
    const generation = c.req.query('generation');
    const snapshot = c.req.query('snapshot') === '1';
    return streamSSE(c, async (stream) => {
      const open = registerStream({
        client,
        session,
        generation,
        write: (event) => stream.writeSSE(sseFrame(event)),
      });
      const detach = (): void => unregisterStream(open);
      c.req.raw.signal.addEventListener('abort', detach, { once: true });
      if (snapshot && session) {
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ cursor: 0 }), id: '0' });
      }
      // Comment flush so the SSE channel connects through the BFF proxy on a quiet system.
      await stream.write(': connected\n\n');
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(15000);
        if (c.req.raw.signal.aborted) break;
        await stream.write(': ping\n\n');
      }
      detach();
    });
  });
}
