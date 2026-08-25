import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';

let body: unknown = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], security: { tokenTtlDays: 30 } })),
  http.put('*/api/config', async ({ request }) => { body = await request.json(); return HttpResponse.json({ allowedExecs: ['sonnet'], security: { tokenTtlDays: 45 } }); }),
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
});
