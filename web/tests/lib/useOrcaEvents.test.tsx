import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrcaEvents } from '../../lib/useOrcaEvents';

class FakeES {
  static last: FakeES;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  close() { this.closed = true; }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => { (globalThis as any).EventSource = FakeES as any; });

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
    FakeES.last.onmessage?.({ data: 'not json' }); // must not throw
  });
  it('closes the source on unmount', () => {
    const { wrapper } = wrap();
    const { unmount } = renderHook(() => useOrcaEvents(), { wrapper });
    const es = FakeES.last; unmount();
    expect(es.closed).toBe(true);
  });
});
