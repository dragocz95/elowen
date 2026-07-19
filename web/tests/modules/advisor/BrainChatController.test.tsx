import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse, delay } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { openBrainSession } from '../../../lib/brainDock';

/** EventSource stand-in that records its URL and lets a test drive per-event listeners by hand — plus a
 *  raw emitter for the data-less transport 'error' the browser fires on a plain connection drop. */
class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  /** Emit a normal JSON frame (routed by `type`). */
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
  /** Emit a brain error FRAME (JSON body on the 'error' channel). */
  emitErrorFrame(message: string) {
    for (const fn of this.listeners.get('error') ?? []) fn({ data: JSON.stringify({ type: 'error', message }) });
  }
  /** Emit a data-less transport 'error' (native auto-reconnect signal — must be ignored). */
  emitTransportError() {
    for (const fn of this.listeners.get('error') ?? []) fn({});
  }
}

let startBodies: Record<string, unknown>[] = [];
let sendBodies: Record<string, unknown>[] = [];

const server = setupServer(
  http.post('*/api/brain/start', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    startBodies.push(body);
    const sessionId = typeof body['session'] === 'string' ? (body['session'] as string) : 'brain-1';
    if (sessionId === 'slow') await delay(60); // a superseded A/B switch resolves LATE
    return HttpResponse.json({ sessionId }, { status: 201 });
  }),
  http.post('*/api/brain/send', async ({ request }) => { sendBodies.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ ok: true }, { status: 202 }); }),
  http.get('*/api/brain/messages', () => HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; startBodies = []; sendBodies = []; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** Provider + N chat surfaces, gated by a `show` toggle so a test can unmount/remount the presentational
 *  surface (the Chat↔Terminál toggle) while the provider — and its stream — stays mounted. */
function Harness({ surfaces = 1 }: { surfaces?: number }) {
  const [show, setShow] = useState(true);
  return (
    <BrainChatProvider>
      <button type="button" onClick={() => setShow((v) => !v)}>toggle</button>
      {show ? Array.from({ length: surfaces }, (_, i) => <BrainChat key={i} />) : <div>terminal</div>}
    </BrainChatProvider>
  );
}

function renderHarness(surfaces = 1) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><Harness surfaces={surfaces} /></ToastProvider></Wrapper>);
}

describe('BrainChat session-bound controller', () => {
  it('boots ONE controller / ONE EventSource even with two mounted surfaces', async () => {
    renderHarness(2);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    expect(startBodies.length).toBe(1); // a single brainStart, not one per surface
  });

  it('threads a stable clientId + generation + bound session onto start, the stream URL and send', async () => {
    renderHarness();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    // brainStart claimed the tab's client identity + the first generation.
    const start = startBodies[0]!;
    expect(typeof start['client']).toBe('string');
    expect(start['generation']).toBe(1);
    const clientId = start['client'] as string;

    // The stream URL carries session + the SAME clientId + generation (native ES can't set headers).
    const url = new URL(FakeES.instances[0]!.url, 'http://x');
    expect(url.searchParams.get('session')).toBe('brain-1');
    expect(url.searchParams.get('client')).toBe(clientId);
    expect(url.searchParams.get('generation')).toBe('1');

    // A send binds to the same conversation/identity.
    const textarea = await screen.findByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'hi' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ session: 'brain-1', client: clientId, generation: 1 });
  });

  it('keeps the draft and the live stream across a Chat↔Terminál toggle (no remount, no reconnect)', async () => {
    renderHarness();
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const es = FakeES.instances[0]!;
    act(() => fireEvent.change(textarea, { target: { value: 'unsent draft' } }));

    // Flip to terminal (unmounts the surface) then back to chat (remounts it).
    act(() => fireEvent.click(screen.getByRole('button', { name: 'toggle' })));
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'toggle' })));

    // Same stream instance (never closed), and the draft survived because it lives in the provider.
    const textarea2 = await screen.findByRole('textbox');
    expect(textarea2).toHaveValue('unsent draft');
    expect(FakeES.instances.length).toBe(1);
    expect(es.closed).toBe(false);
  });

  it('reconnects on a brain error FRAME but ignores a data-less transport drop (turn survives)', async () => {
    vi.useFakeTimers();
    try {
      renderHarness();
      await vi.waitFor(() => expect(FakeES.instances.length).toBe(1));
      const es = FakeES.instances[0]!;

      // A data-less transport error is the browser's own reconnect — no teardown, no new stream.
      act(() => es.emitTransportError());
      expect(FakeES.instances.length).toBe(1);
      expect(es.closed).toBe(false);

      // A brain error frame closes the stream and schedules a full reconnect.
      act(() => es.emitErrorFrame('brain not started'));
      expect(es.closed).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      await vi.waitFor(() => expect(FakeES.instances.length).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a superseded (older-generation) switch so the latest conversation wins', async () => {
    renderHarness();
    await waitFor(() => expect(FakeES.instances.length).toBe(1)); // initial default connect

    const textarea = await screen.findByRole('textbox');
    // Two switches back-to-back: the FIRST ("slow") resolves LATE, the SECOND ("fast") wins.
    act(() => { openBrainSession('slow', true); openBrainSession('fast', true); });

    await waitFor(() => {
      const last = FakeES.instances[FakeES.instances.length - 1]!;
      expect(new URL(last.url, 'http://x').searchParams.get('session')).toBe('fast');
    });
    // Give the slow start time to resolve and (correctly) be discarded.
    await act(async () => { await delay(120); });

    // The bound conversation is the winner: a send targets 'fast', never the discarded 'slow'.
    act(() => fireEvent.change(textarea, { target: { value: 'go' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]!['session']).toBe('fast');
    expect(FakeES.instances.some((e) => new URL(e.url, 'http://x').searchParams.get('session') === 'slow')).toBe(false);
  });

  it('rebinds on idle-rollover WITHOUT bumping the generation', async () => {
    renderHarness();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const es = FakeES.instances[0]!;

    // The server rolled the idle conversation over into a fresh one.
    act(() => es.emit({ type: 'session', sessionId: 'rolled-1' }));

    const textarea = await screen.findByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'after rollover' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    // Bound to the replacement conversation, but the generation is UNCHANGED (rebind, not a new start).
    expect(sendBodies[0]).toMatchObject({ session: 'rolled-1', generation: 1 });
  });

  it('detaches on tab-close (pagehide → sendBeacon), but never on a plain SSE drop', async () => {
    const beacon = vi.fn(() => true);
    (navigator as unknown as { sendBeacon: typeof beacon }).sendBeacon = beacon;
    renderHarness();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    // A plain transport drop must NOT detach the session (the turn survives).
    act(() => FakeES.instances[0]!.emitTransportError());
    expect(beacon).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toContain('/brain/session/stop');
    const raw = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(payload).toMatchObject({ session: 'brain-1', generation: 1 });
    expect(typeof payload['client']).toBe('string');
  });
});
