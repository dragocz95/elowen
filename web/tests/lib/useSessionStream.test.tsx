import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStream } from '../../lib/useSessionStream';
import { setToken, getToken } from '../../lib/token';

class FakeES {
  static readonly CLOSED = 2;
  static last: FakeES;
  listeners: Record<string, (e: { data: string }) => void> = {};
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, fn: (e: { data: string }) => void) { this.listeners[type] = fn; }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
}
beforeEach(() => { (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES; localStorage.clear(); });

describe('useSessionStream', () => {
  it('returns the latest pane from a pane event', () => {
    const { result } = renderHook(() => useSessionStream('orca-A'));
    expect(FakeES.last.url).toContain('/sessions/orca-A/stream');
    act(() => FakeES.last.emit('pane', { pane: 'frame-1' }));
    expect(result.current).toBe('frame-1');
    act(() => FakeES.last.listeners['pane']?.({ data: 'not json' })); // malformed → skipped, no throw
    expect(result.current).toBe('frame-1');
  });
  it('closes the source on unmount', () => {
    const { unmount } = renderHook(() => useSessionStream('orca-A'));
    const es = FakeES.last; unmount();
    expect(es.closed).toBe(true);
  });

  // A CLOSED error stops the retry loop but must NOT clear the auth token (EventSource can't tell a
  // 401 from a benign drop). Clearing it here logged users out spuriously on a hard reload.
  it('closes on a CLOSED error WITHOUT clearing the token', () => {
    setToken('still-valid');
    renderHook(() => useSessionStream('orca-A'));
    const es = FakeES.last;
    es.readyState = FakeES.CLOSED;
    es.onerror?.();
    expect(getToken()).toBe('still-valid');
    expect(es.closed).toBe(true);
  });
  it('keeps the token on a transient (non-CLOSED) error', () => {
    setToken('valid');
    renderHook(() => useSessionStream('orca-A'));
    const es = FakeES.last;
    es.readyState = 0;
    es.onerror?.();
    expect(getToken()).toBe('valid');
    expect(es.closed).toBe(false);
  });
});
