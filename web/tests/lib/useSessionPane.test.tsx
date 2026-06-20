import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useSessionPane } from '../../lib/useSessionPane';
import { createWrapper } from '../test-utils';

let paneHits = 0;
const server = setupServer(
  http.get('http://localhost:4400/sessions/:name/pane', () => {
    paneHits++;
    return HttpResponse.json({ pane: 'line1\nline2\nline3' });
  }),
);

beforeAll(() => server.listen());
afterEach(() => { paneHits = 0; });
afterAll(() => server.close());

describe('useSessionPane', () => {
  it('returns the last N lines of the pane when enabled', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPane('s1', 2), { wrapper });
    await waitFor(() => expect(result.current.tail).toBe('line2\nline3'));
  });

  it('does not poll when enabled is false', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPane('dead', 8, false), { wrapper });
    // Give the query a chance to fire if it were going to.
    await new Promise((r) => setTimeout(r, 50));
    expect(paneHits).toBe(0);
    expect(result.current.tail).toBe('');
  });

  it('does not poll when the name is empty', async () => {
    const { wrapper } = createWrapper();
    renderHook(() => useSessionPane('', 8, true), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(paneHits).toBe(0);
  });
});
