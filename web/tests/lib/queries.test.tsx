import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useProjects } from '../../lib/queries';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen' }])),
);

beforeAll(() => server.listen());
afterAll(() => server.close());

describe('useProjects', () => {
  it('fetches projects via elowenClient', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjects(), { wrapper });
    await waitFor(() => expect(result.current.data?.[0]?.slug).toBe('elowen'));
  });
});
