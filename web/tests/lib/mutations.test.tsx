import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useAssignProject, useSavePluginConfig, useTogglePlugin, useResetUsage, useWriteProjectFile } from '../../lib/mutations';

let lastAssignCall: { method: string; userId: string; projectId?: string } | null = null;
const server = setupServer(
  http.post('*/api/users/:userId/projects', async ({ params, request }) => {
    const body = (await request.json()) as { projectId: number };
    lastAssignCall = { method: 'POST', userId: String(params.userId), projectId: String(body.projectId) };
    return HttpResponse.json({ ok: true });
  }),
  http.delete('*/api/users/:userId/projects/:projectId', ({ params }) => {
    lastAssignCall = { method: 'DELETE', userId: String(params.userId), projectId: String(params.projectId) };
    return HttpResponse.json({ ok: true });
  }),
  http.patch('*/api/plugins/:name/config', () => HttpResponse.json({ ok: true })),
  http.patch('*/api/plugins/:name', () => HttpResponse.json({ name: 'dev-commands', enabled: false })),
  http.post('*/api/usage/reset', () => HttpResponse.json({ ok: true })),
  http.put('*/api/projects/:id/file', () => HttpResponse.json({ ok: true })),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('plugin mutations re-pull the slash menu', () => {
  // A plugin's config (e.g. dev-commands' enabled set) or on/off state changes which slash commands the
  // daemon publishes, so the menu's single source (GET /brain/commands) must be invalidated — otherwise the
  // web dock keeps showing commands the operator just turned off.
  const wrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  it('config save invalidates brain-commands', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSavePluginConfig(), { wrapper: wrapper(client) });
    result.current.mutate({ name: 'dev-commands', values: { enabled: ['commit'] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-commands'] });
  });

  it('toggling a plugin invalidates brain-commands', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTogglePlugin(), { wrapper: wrapper(client) });
    result.current.mutate({ name: 'dev-commands', enabled: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brain-commands'] });
  });
});

describe('useAssignProject', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );

  it('assigns when the project is not currently assigned', async () => {
    lastAssignCall = null;
    const { result } = renderHook(() => useAssignProject(), { wrapper });
    result.current.mutate({ userId: 7, projectId: 3, currentlyAssigned: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lastAssignCall).toEqual({ method: 'POST', userId: '7', projectId: '3' });
  });

  it('unassigns when the project is currently assigned', async () => {
    lastAssignCall = null;
    const { result } = renderHook(() => useAssignProject(), { wrapper });
    result.current.mutate({ userId: 7, projectId: 3, currentlyAssigned: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lastAssignCall).toEqual({ method: 'DELETE', userId: '7', projectId: '3' });
  });
});

describe('useResetUsage', () => {
  it('invalidates the by-model and by-day caches', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useResetUsage(), { wrapper });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['usage-by-model'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['usage-by-day'] });
  });
});

describe('useWriteProjectFile', () => {
  // The editor's changed-path highlighting reads 'project-changed'; without invalidating it a save
  // leaves the tree claiming the just-edited file is unchanged.
  it('invalidates the file, git summary and changed-path caches', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWriteProjectFile(), { wrapper });
    result.current.mutate({ id: 5, path: 'a.ts', content: 'new content' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-file', 5, 'a.ts'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-git', 5] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-changed', 5] });
  });

  // The editor clears its local draft on save success and falls back to the file cache, so the cache
  // must already hold the new content — otherwise it flashes the stale pre-save version until refetch.
  it('updates the file cache with the written content synchronously', async () => {
    const client = new QueryClient();
    client.setQueryData(['project-file', 5, 'a.ts'], { content: 'old content', truncated: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWriteProjectFile(), { wrapper });
    result.current.mutate({ id: 5, path: 'a.ts', content: 'new content' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(['project-file', 5, 'a.ts'])).toEqual({ content: 'new content', truncated: false });
  });
});
