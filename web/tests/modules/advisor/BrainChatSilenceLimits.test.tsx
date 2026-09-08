import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { first } from '../../first.js';

// Both silence limits are operator-tunable (`runtime.limits`), and the web cannot import the daemon — the
// values reach the browser over GET /config. These tests pin that they ARRIVE: that the watchdog polls
// against the configured limit rather than its built-in 75 s, and that the wake-up path judges staleness
// against the configured wake limit rather than its built-in 45 s. Each configured case is paired with the
// same silence under the defaults, so neither assertion can pass vacuously.

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
}

let startBodies: Record<string, unknown>[] = [];
let runtimeLimits: { streamSilenceLimitMs?: number; streamReviveSilenceLimitMs?: number } | null = null;

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({
    allowedExecs: [], customModels: [], hiddenPresets: [], modelNotes: {}, providers: {},
    defaults: { exec: '', maxSessions: 4 },
    ...(runtimeLimits ? { runtime: { limits: runtimeLimits, toolDeferralEnabled: true } } : {}),
  })),
  http.post('*/api/brain/start', async ({ request }) => {
    startBodies.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 });
  }),
  http.post('*/api/brain/session/stop', () => HttpResponse.json({ stopped: false, disposed: false })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

/** The watchdog polls on an interval; the wall clock it measures against is driven by hand, exactly as in
 *  the wake-up tests. Only the interval is faked, so msw and `waitFor` keep running on real time. */
let clock = 1_900_000_000_000;

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  startBodies = [];
  runtimeLimits = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  clock += 3_600_000; // the shared revive emitter coalesces per wall clock — keep tests far apart
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

/** Render the chat and wait until the config the watchdog reads has actually reached the cache. */
async function renderChat(): Promise<void> {
  const { wrapper: Wrapper, client } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  await waitFor(() => expect(client.getQueryData(['config'])).toBeTruthy());
}

/** One watchdog poll, after `silentMs` of nothing arriving on the stream. */
function tickAfterSilence(silentMs: number): void {
  clock += silentMs;
  act(() => { vi.advanceTimersByTime(5_000); });
}

describe('the stream watchdog reads its limit from the daemon config', () => {
  it('gives up on a stream that passed the CONFIGURED silence limit', async () => {
    runtimeLimits = { streamSilenceLimitMs: 40_000 };
    await renderChat();

    tickAfterSilence(41_000);

    expect(first(FakeES.instances, 'EventSource').closed).toBe(true);
    await waitFor(() => expect(startBodies.length).toBe(2));
  });

  it('leaves that same silence alone on the default limit', async () => {
    await renderChat();

    tickAfterSilence(41_000); // well inside the built-in 75 s

    expect(first(FakeES.instances, 'EventSource').closed).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(startBodies.length).toBe(1);
  });
});

describe('the wake-up path reads its limit from the daemon config', () => {
  it('accepts a silence the CONFIGURED wake limit still tolerates', async () => {
    runtimeLimits = { streamReviveSilenceLimitMs: 120_000 };
    await renderChat();

    clock += 60_000; // past the built-in 45 s, inside the configured 120 s
    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await new Promise((r) => setTimeout(r, 20));
    expect(startBodies.length).toBe(1);
    expect(FakeES.instances.length).toBe(1);
  });

  it('reconnects at that same silence on the default wake limit', async () => {
    await renderChat();

    clock += 60_000;
    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await waitFor(() => expect(startBodies.length).toBe(2));
  });
});
