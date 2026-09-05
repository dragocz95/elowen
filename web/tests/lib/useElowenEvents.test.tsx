import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useElowenEvents } from '../../lib/useElowenEvents';

class FakeES {
  static readonly CLOSED = 2;
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, handler: (event: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

const coreStream = (): FakeES => FakeES.instances.find((stream) => stream.url.endsWith('/events'))!;
const conversationsStream = (): FakeES => FakeES.instances.find((stream) => stream.url.endsWith('/brain/conversations'))!;

beforeEach(() => {
  FakeES.instances.length = 0;
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
});

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
    coreStream().emit('memory', { type: 'memory', userId: 1 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memories'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memory-vitality'] });
  });

  it('refreshes plugin surfaces when the daemon swaps its registry', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    coreStream().emit('plugins', { type: 'plugins' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugin-ui'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plugins'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['marketplace'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-commands'] });
  });

  it('invalidates the conversation list from the user-scoped conversation stream', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    expect(conversationsStream().url).toBe('/api/brain/conversations');
    conversationsStream().emit('conversations', { updates: [{ sessionId: 'brain-1', seq: 4 }] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-sessions'] });
  });

  it('ignores malformed event payloads', () => {
    const { spy, wrapper } = wrap();
    renderHook(() => useElowenEvents(), { wrapper });
    expect(() => coreStream().emit('memory', 'not json')).not.toThrow();
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['memories'] });
  });
});
