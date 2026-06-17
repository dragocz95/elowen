import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useSpawn } from '../../lib/mutations';

const server = setupServer(http.post('http://localhost:4400/sessions', () => HttpResponse.json({ session: 'orca-A' }, { status: 201 })));
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('useSpawn', () => {
  it('invalidates tasks + sessions on success', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSpawn(), { wrapper });
    result.current.mutate({ taskId: 'orca-1', exec: 'sonnet' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });
});
