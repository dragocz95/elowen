import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';

let body: unknown = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], security: { tokenTtlDays: 30 }, revision: 7 })),
  http.put('*/api/config', async ({ request }) => { body = await request.json(); return HttpResponse.json({ allowedExecs: ['sonnet'], security: { tokenTtlDays: 45 }, revision: 8 }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

function wrap() { const c = new QueryClient(); return ({ children }: { children: ReactNode }) => <QueryClientProvider client={c}>{children}</QueryClientProvider>; }

describe('config hooks', () => {
  it('useConfig fetches the config', async () => {
    const { result } = renderHook(() => useConfig(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.allowedExecs).toEqual(['sonnet']));
  });
  it('useUpdateConfig PUTs the patch', async () => {
    const { result } = renderHook(() => useUpdateConfig(), { wrapper: wrap() });
    result.current.mutate({ security: { tokenTtlDays: 45 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(body).toMatchObject({ security: { tokenTtlDays: 45 } });
  });

  it('sends the cached revision and stores the canonical response', async () => {
    const client = new QueryClient();
    client.setQueryData(['config'], { revision: 7, security: { tokenTtlDays: 30 } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUpdateConfig(), { wrapper });
    result.current.mutate({ security: { tokenTtlDays: 45 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(body).toMatchObject({ security: { tokenTtlDays: 45 }, expectedRevision: 7 });
    expect(client.getQueryData(['config'])).toMatchObject({ revision: 8, security: { tokenTtlDays: 45 } });
  });

  it('adopts conflict state so an explicit retry sends the current revision', async () => {
    const bodies: unknown[] = [];
    let attempt = 0;
    server.use(http.put('*/api/config', async ({ request }) => {
      bodies.push(await request.json());
      attempt++;
      if (attempt === 1) {
        return HttpResponse.json({ error: 'conflict', current: { revision: 8, autoUpdate: true } }, { status: 409 });
      }
      return HttpResponse.json({ revision: 9, autoUpdate: false });
    }));
    const client = new QueryClient();
    client.setQueryData(['config'], { revision: 7, autoUpdate: true });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUpdateConfig(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ autoUpdate: false })).rejects.toThrow('409');
    });
    expect(client.getQueryData(['config'])).toMatchObject({ revision: 8, autoUpdate: true });

    await act(async () => { await result.current.mutateAsync({ autoUpdate: false }); });
    expect(bodies[1]).toMatchObject({ autoUpdate: false, expectedRevision: 8 });
    expect(client.getQueryData(['config'])).toMatchObject({ revision: 9, autoUpdate: false });
  });
});
