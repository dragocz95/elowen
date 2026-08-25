import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useElowenEvents } from '../../lib/useElowenEvents';

class FakeES {
  static readonly CLOSED = 2;
  static last: FakeES;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, handler: (event: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function wrap() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { spy, wrapper };
}

describe('useElowenEvents', () => {
  it('refreshes memory caches on a memory event', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    FakeES.last.emit('memory', { type: 'memory', userId: 1 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memories'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memory-vitality'] });
  });

  it('refreshes plugin surfaces when the daemon swaps its registry', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    FakeES.last.emit('plugins', { type: 'plugins' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugin-ui'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugins'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['marketplace'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-commands'] });
  });

  it('ignores malformed event payloads', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    expect(() => FakeES.last.emit('memory', 'not json')).not.toThrow();
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['memories'] });
  });
});
