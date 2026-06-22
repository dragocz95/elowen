import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useOrcaEvents } from '../../lib/useOrcaEvents';

class FakeES {
  url: string; withCredentials: boolean; readyState = 0;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(url: string, init?: { withCredentials?: boolean }) { this.url = url; this.withCredentials = init?.withCredentials ?? false; instances.push(this); }
  addEventListener() {} close() {}
}
const instances: FakeES[] = [];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => { instances.length = 0; vi.stubGlobal('EventSource', FakeES as never); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('SSE hooks', () => {
  it('opens a same-origin /api/events stream with credentials and no token query', () => {
    renderHook(() => useOrcaEvents({}), { wrapper });
    expect(instances[0].url).toBe('/api/events');
    expect(instances[0].url).not.toContain('token=');
    expect(instances[0].withCredentials).toBe(true);
  });
});
