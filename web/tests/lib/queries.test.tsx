import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useTasks } from '../../lib/queries';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('http://localhost:4400/tasks', () =>
    HttpResponse.json([{ id: 'orca-1', title: 'A', status: 'open' }]),
  ),
);

beforeAll(() => server.listen());
afterAll(() => server.close());

describe('useTasks', () => {
  it('fetches tasks via orcaClient', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTasks(), { wrapper });
    await waitFor(() => expect(result.current.data?.[0].id).toBe('orca-1'));
  });
});
