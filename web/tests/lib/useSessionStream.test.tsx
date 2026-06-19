import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStream } from '../../lib/useSessionStream';

class FakeES {
  static last: FakeES;
  listeners: Record<string, (e: { data: string }) => void> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, fn: (e: { data: string }) => void) { this.listeners[type] = fn; }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
}
beforeEach(() => { (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES; });

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
});
