import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrcaEvents } from '../../lib/useOrcaEvents';
import { setToken, getToken } from '../../lib/token';

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

beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; localStorage.clear(); });

function wrap() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, spy, wrapper };
}

describe('useOrcaEvents', () => {
  it('invalidates tasks on a task event and ignores malformed payloads', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useOrcaEvents(), { wrapper });
    FakeES.last.emit({ type: 'task', taskId: 'orca-1', status: 'closed' });
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
    renderHook(() => useOrcaEvents({ onReview }), { wrapper });
    FakeES.last.emit({ type: 'review', missionId: 'm-1', taskId: 'orca-9', approve: false, rationale: 'scope creep' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(onReview).toHaveBeenCalledWith({ missionId: 'm-1', taskId: 'orca-9', approve: false, rationale: 'scope creep' });
  });

  it('does not reopen the SSE connection when only the onReview identity changes', () => {
    const { wrapper } = wrap();
    const first = vi.fn();
    const { rerender } = renderHook(({ cb }) => useOrcaEvents({ onReview: cb }), { wrapper, initialProps: { cb: first } });
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

  it('closes the source on unmount', () => {
    const { wrapper } = wrap();
    const { unmount } = renderHook(() => useOrcaEvents(), { wrapper });
    const es = FakeES.last; unmount();
    expect(es.closed).toBe(true);
  });

  // A CLOSED error stops the retry loop but must NOT clear the auth token: EventSource can't tell a
  // 401 from a benign drop (proxy/SSE timeout, daemon restart, hard-reload race), so clearing here
  // logged users out spuriously. Real auth expiry is handled by the regular request path.
  it('closes on a CLOSED error WITHOUT clearing the token', () => {
    setToken('still-valid');
    const { wrapper } = wrap();
    renderHook(() => useOrcaEvents(), { wrapper });
    const es = FakeES.last;
    es.readyState = FakeES.CLOSED;
    es.onerror?.();
    expect(getToken()).toBe('still-valid'); // never logged out by an SSE drop
    expect(es.closed).toBe(true);
  });
  it('keeps the token on a transient (non-CLOSED) error', () => {
    setToken('valid');
    const { wrapper } = wrap();
    renderHook(() => useOrcaEvents(), { wrapper });
    const es = FakeES.last;
    es.readyState = 0; // CONNECTING — browser will retry on its own
    es.onerror?.();
    expect(getToken()).toBe('valid');
    expect(es.closed).toBe(false);
  });
});
