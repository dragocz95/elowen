// Out-of-band test control channel (NOT part of the real daemon API). A spec POSTs here to push a
// specific BrainEvent frame into an open `/brain/stream` connection, drive a turn to idle, inspect what
// the UI sent, or reset recorded state between tests. Addressed by the same client/session the web used
// to open its EventSource.
import type { Hono } from 'hono';
import type { BrainEvent } from '../emitters.ts';
import { idleEvent } from '../emitters.ts';
import type { IdleEvent } from '../emitters.ts';
import { emitToStreams, openStreams } from '../streams.ts';
import { sentTurns, recordedControlCalls, resetSentTurns } from './brain.ts';
import type { BrainMessage } from '../../../../lib/types.ts';
import type { OverrideKey } from '../overrides.ts';
import { setResponseOverride, setMessagesOverride, resetOverrides } from '../overrides.ts';
import { setSetupMode, needsSetup, resetSetup } from '../setup.ts';

export function registerControlRoutes(app: Hono): void {
  // Push one arbitrary BrainEvent into every stream matching {client?, session?} (both omitted =
  // broadcast to all open streams). Returns how many connections received it.
  app.post('/__test/emit', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { client?: string; session?: string; generation?: string; event?: BrainEvent }
      | null;
    if (!body || typeof body.event !== 'object' || body.event === null || typeof body.event.type !== 'string') {
      return c.json({ error: 'event required' }, 400);
    }
    const delivered = await emitToStreams({ client: body.client, session: body.session, generation: body.generation }, body.event);
    return c.json({ delivered });
  });

  // Convenience: drive the matching stream(s) to the terminal `idle` frame that ends a turn.
  app.post('/__test/idle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      client?: string;
      session?: string;
      usage?: IdleEvent['usage'];
      model?: string;
    };
    const delivered = await emitToStreams({ client: body.client, session: body.session }, idleEvent({ usage: body.usage, model: body.model }));
    return c.json({ delivered });
  });

  // Report the currently-open `/brain/stream` connections (optionally filtered by session), so a spec can
  // wait for the browser's EventSource to register before it scripts frames — an emit before the stream
  // connects is silently dropped. Returns the matching {client, session} pairs and their count.
  app.get('/__test/streams', (c) => {
    const session = c.req.query('session');
    const streams = openStreams()
      .filter((s) => session === undefined || s.session === session)
      .map((s) => ({ id: s.id, client: s.client, session: s.session, generation: s.generation }));
    return c.json({ streams, count: streams.length });
  });

  // Inspect the turns the UI has posted to `/brain/send` so far.
  app.get('/__test/sent', (c) => c.json({ sent: sentTurns() }));

  // Inspect the non-send control calls the UI has posted (the /model switch, the Stop abort), so a spec
  // can assert the exact upstream payload the web sent.
  app.get('/__test/calls', (c) => c.json({ calls: recordedControlCalls() }));

  // Arm/disarm the fresh-install lane: while on (and no admin created yet) `GET /setup` reports
  // needsSetup:true and `POST /users` bootstraps the first admin. Returns the resulting probe value.
  app.post('/__test/setup', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { needsSetup?: unknown };
    setSetupMode(body.needsSetup === true);
    return c.json({ ok: true, needsSetup: needsSetup() });
  });

  // Override the canned answers a polled GET / the seed transcript returns, BEFORE a spec navigates —
  // the daemon-side twin of the `seed` fixture. `responses` replaces a polled endpoint's body wholesale
  // (keyed by its GET path, no leading slash); `messages` (incl. `[]`) replaces the seed transcript, or
  // `null` restores it. The web is never mocked in the browser — this still travels the real pipeline.
  app.post('/__test/seed', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { responses?: Partial<Record<OverrideKey, unknown>>; messages?: BrainMessage[] | null }
      | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    if (body.responses) {
      for (const [key, value] of Object.entries(body.responses)) setResponseOverride(key as OverrideKey, value);
    }
    if (body.messages !== undefined) setMessagesOverride(body.messages ?? undefined);
    return c.json({ ok: true });
  });

  // Clear per-test recorded state AND seed overrides (call from a spec's beforeEach / afterEach).
  app.post('/__test/reset', (c) => {
    resetSentTurns();
    resetOverrides();
    resetSetup();
    return c.json({ ok: true });
  });
}
