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
import { registerStream, unregisterStream } from '../streams.ts';
import { sseFrame } from '../emitters.ts';
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

const recordedSends: RecordedSend[] = [];

/** Read-only view of the turns the UI has posted so far (exposed via `GET /__test/sent`). */
export function sentTurns(): readonly RecordedSend[] {
  return recordedSends;
}

/** Clear the recorded turns (the control channel's `/__test/reset`). */
export function resetSentTurns(): void {
  recordedSends.length = 0;
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
    return c.json({ ...getResponse('brain/status', brainStatus), ...(session ? { sessionId: session } : {}) });
  });

  app.get('/brain/sessions', (c) => c.json(getResponse('brain/sessions', brainSessions)));
  app.get('/brain/models', (c) => c.json(getResponse('brain/models', brainModels)));
  app.get('/brain/commands', (c) => c.json(getResponse('brain/commands', { commands: brainCommands })));

  app.get('/brain/messages', (c) => {
    const source = getMessages(brainMessages);
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

  // Scriptable live stream. Registers the open connection keyed by client+session; the control channel
  // writes scripted frames into it. Honors `snapshot=1` with a minimal snapshot frame, then keeps the
  // connection open (heartbeat comments) until the client disconnects.
  app.get('/brain/stream', (c) => {
    const session = c.req.query('session');
    const client = c.req.query('client');
    const snapshot = c.req.query('snapshot') === '1';
    return streamSSE(c, async (stream) => {
      const open = registerStream({
        client,
        session,
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
