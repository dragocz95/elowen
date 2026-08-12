import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useElowenEvents } from '../../lib/useElowenEvents';

class FakeES {
  static readonly CLOSED = 2;
  static last: FakeES;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, fn]);
  }
  close() { this.closed = true; }
  emit(obj: Record<string, unknown>) {
    const handlers = this.listeners.get(obj['type'] as string) ?? [];
    for (const fn of handlers) fn({ data: JSON.stringify(obj) });
  }
}

beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function wrap() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, spy, wrapper };
}

describe('useElowenEvents', () => {
  it('invalidates tasks on a task event and ignores malformed payloads', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    FakeES.last.emit({ type: 'task', taskId: 'elowen-1', status: 'closed' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    // malformed payload — must not throw, must be silently skipped
    FakeES.last.addEventListener('task', () => { /* no-op listener to ensure no throw */ });
    const fakeHandler = FakeES.last['listeners' as keyof FakeES] as unknown as Map<string, ((e: { data: string }) => void)[]>;
    const taskHandlers = fakeHandler.get('task') ?? [];
    expect(() => taskHandlers[0]?.({ data: 'not json' })).not.toThrow();
  });
  it('invalidates caches and forwards the verdict on a review event', () => {
    const { spy, wrapper } = wrap();
    const onReview = vi.fn();
    renderHook(() => useElowenEvents({ onReview }), { wrapper });
    FakeES.last.emit({ type: 'review', missionId: 'm-1', taskId: 'elowen-9', approve: false, rationale: 'scope creep' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(onReview).toHaveBeenCalledWith({ missionId: 'm-1', taskId: 'elowen-9', approve: false, rationale: 'scope creep' });
  });

  // A recall changes usage and vitality with nothing on the client to hang a refresh off — queries are
  // SSE-driven and refetchOnWindowFocus is off, so without this the open list keeps stale counters.
  it('refreshes the memory list and its vitality curves on a recall', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });

    FakeES.last.emit({ type: 'memory', userId: 1 });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['memories'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memory-vitality'] });
  });

  // A plugin toggle is persisted the moment its route answers, but the registry swap can land much later
  // (it waits for running work to settle). Without this the nav, the installed list and the slash-command
  // menu kept showing the previous set until the user reloaded the page by hand.
  it('refreshes the plugin surfaces when the daemon swaps its registry', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });

    FakeES.last.emit({ type: 'plugins' });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugin-ui'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugins'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['marketplace'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-commands'] });
  });

  it('does not reopen the SSE connection when only the onReview identity changes', () => {
    const { wrapper } = wrap();
    const first = vi.fn();
    const { rerender } = renderHook(({ cb }) => useElowenEvents({ onReview: cb }), { wrapper, initialProps: { cb: first } });
    const es = FakeES.last;
    // EventBridge passes a fresh inline arrow on every render (a toast re-renders it). The SSE
    // lifecycle must not depend on that identity — else each toast tears down and reopens the stream.
    const second = vi.fn();
    rerender({ cb: second });
    expect(es.closed).toBe(false); // the existing connection was NOT torn down…
    expect(FakeES.last).toBe(es); // …and no replacement was opened
    // …yet the LATEST callback is the one a verdict reaches.
    FakeES.last.emit({ type: 'review', missionId: 'm', taskId: 't', approve: false, rationale: 'r' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('keeps the Pilot sessionName across a later planning SSE update (poll carries it, events do not)', () => {
    const { client, wrapper } = wrap();
    // The GET poll seeds the live-preview session…
    client.setQueryData(['plan-job', 'pj-1'], { id: 'pj-1', goal: 'g', epicId: null, status: 'planning', phases: [], sessionName: 'elowen-pilot-Nova' });
    renderHook(() => useElowenEvents(), { wrapper });
    // …a subsequent `planning` SSE event (which carries no session) must NOT blank out the pane.
    FakeES.last.emit({ type: 'plan', jobId: 'pj-1', status: 'planning' });
    const job = client.getQueryData(['plan-job', 'pj-1']) as { sessionName?: string };
    expect(job.sessionName).toBe('elowen-pilot-Nova');
  });

  it('closes the source on unmount', () => {
    const { wrapper } = wrap();
    const { unmount } = renderHook(() => useElowenEvents(), { wrapper });
    const es = FakeES.last; unmount();
    expect(es.closed).toBe(true);
  });

  // A CLOSED error stops the retry loop but must NOT clear the auth token: EventSource can't tell a
  // 401 from a benign drop (proxy/SSE timeout, daemon restart, hard-reload race), so clearing here
  // logged users out spuriously. Real auth expiry is handled by the regular request path.
  it('closes the source on a CLOSED error', () => {
    const { wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    const es = FakeES.last;
    es.readyState = FakeES.CLOSED;
    es.onerror?.();
    expect(es.closed).toBe(true);
  });
  it('leaves the source open on a transient (non-CLOSED) error', () => {
    const { wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    const es = FakeES.last;
    es.readyState = 0; // CONNECTING — browser will retry on its own
    es.onerror?.();
    expect(es.closed).toBe(false);
  });

  it('reopens the channel when the page wakes on a socket that is no longer live', async () => {
    const { wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    const es = FakeES.last;
    es.readyState = FakeES.CLOSED; // iOS tore it down while the page was frozen

    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await waitFor(() => expect(FakeES.last).not.toBe(es));
    expect(es.closed).toBe(true); // the dead one is not left dangling
  });
});
