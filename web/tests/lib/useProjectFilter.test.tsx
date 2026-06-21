import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { useProjectFilter } from '../../lib/useProjectFilter';
import { createWrapper } from '../test-utils';

// The project list loads asynchronously (GET /projects) — useProjects is undefined on first render.
const server = setupServer(
  http.get('*/projects', () => HttpResponse.json([
    { id: 1, slug: 'orca', path: '/o', notes: '' },
    { id: 2, slug: 'other', path: '/p2', notes: '' },
  ])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

describe('useProjectFilter', () => {
  it('restores the stored project id even though the project list loads asynchronously', async () => {
    localStorage.setItem('orca.tasks.project', '2');
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectFilter('orca.tasks.project'), { wrapper });
    // The bug: with an async-derived allow-list the stored id was rejected on mount and the filter
    // silently fell back to 'all'. A static key check restores it regardless of load timing.
    await waitFor(() => expect(result.current.selectedProject).toBe(2));
  });

  it('clamps to all when the stored project no longer exists', async () => {
    localStorage.setItem('orca.tasks.project', '999'); // a deleted/foreign project id
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectFilter('orca.tasks.project'), { wrapper });
    // Wait for the project list to load, then the unknown id must clamp to 'all' (no invisible filter).
    await waitFor(() => expect(result.current.selectedProject).toBe('all'));
  });

  it('defaults to all when nothing is stored', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectFilter('orca.tasks.project'), { wrapper });
    expect(result.current.selectedProject).toBe('all');
  });
});
