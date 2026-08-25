import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { elowenClient, ElowenApiError, apiErrorMessage } from '../../lib/elowenClient';

// The client now talks to the same-origin /api proxy; handlers match any origin's /api/* path.
const server = setupServer();
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('elowenClient', () => {
  // With no opts the activity URL must not carry a dangling trailing '?'.
  it('activity() omits the trailing ? when no options are given', async () => {
    let seen = '';
    server.use(http.get('*/api/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await elowenClient.activity();
    expect(seen).toBe('');
  });
  it('activity({ limit }) builds a proper query string', async () => {
    let seen = '';
    server.use(http.get('*/api/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await elowenClient.activity({ limit: 5 });
    expect(seen).toBe('?limit=5');
  });

  it('usageByModel() with no args omits every query param', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await elowenClient.usageByModel();
    expect(seen).toBe('');
  });
  it('usageByModel(window) sends finite ISO bounds', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await elowenClient.usageByModel({ fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 5, 30) });
    const params = new URLSearchParams(seen);
    expect(params.get('from')).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(params.get('to')).toBe(new Date(Date.UTC(2026, 5, 30)).toISOString());
  });
  it('usageByModel(window) omits an infinite bound', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await elowenClient.usageByModel({ fromMs: Date.UTC(2026, 5, 1), toMs: Infinity });
    const params = new URLSearchParams(seen);
    expect(params.has('to')).toBe(false);
    expect(params.get('from')).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
  });
});

// W4: the ElowenApiError contract is actually consumed — prefer the server's error code over the
// raw diagnostic so toasts read "forbidden", not "Error: elowen 403 on /tasks".
describe('apiErrorMessage', () => {
  it('prefers the server error code on an ElowenApiError', () => {
    expect(apiErrorMessage(new ElowenApiError('elowen 403 on /tasks', 403, 'forbidden'))).toBe('forbidden');
  });
  it('falls back to the message when there is no code', () => {
    expect(apiErrorMessage(new ElowenApiError('elowen 500 on /tasks', 500))).toBe('elowen 500 on /tasks');
  });
  it('handles plain Errors and unknown values', () => {
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
    expect(apiErrorMessage('nope')).toBe('nope');
  });
});
