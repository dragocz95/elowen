import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { orcaClient, OrcaApiError, apiErrorMessage } from '../../lib/orcaClient';

// The client now talks to the same-origin /api proxy; handlers match any origin's /api/* path.
const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'A', status: 'open' }])),
  http.get('*/api/missions', () => new HttpResponse(null, { status: 500 })),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('orcaClient', () => {
  it('tasks() returns parsed JSON', async () => {
    const tasks = await orcaClient.tasks();
    expect(tasks[0].id).toBe('orca-1');
  });
  it('throws OrcaApiError with status on non-ok', async () => {
    await expect(orcaClient.missions()).rejects.toMatchObject({ status: 500 });
    await expect(orcaClient.missions()).rejects.toBeInstanceOf(OrcaApiError);
  });

  // W1: a 2xx with a non-JSON body (e.g. an HTML proxy page) must surface a typed OrcaApiError,
  // not an opaque SyntaxError leaking from res.json().
  it('throws OrcaApiError (not SyntaxError) on a non-JSON 2xx body', async () => {
    server.use(http.get('*/api/tasks', () => new HttpResponse('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(orcaClient.tasks()).rejects.toBeInstanceOf(OrcaApiError);
    await expect(orcaClient.tasks()).rejects.toMatchObject({ status: 200 });
  });
  it('returns undefined on a 204 No Content without parsing', async () => {
    server.use(http.delete('*/api/tasks/orca-1', () => new HttpResponse(null, { status: 204 })));
    await expect(orcaClient.deleteTask('orca-1')).resolves.toBeUndefined();
  });

  // W3: with no opts the activity URL must not carry a dangling trailing '?'.
  it('activity() omits the trailing ? when no options are given', async () => {
    let seen = '';
    server.use(http.get('*/api/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.activity();
    expect(seen).toBe('');
  });
  it('activity({ limit }) builds a proper query string', async () => {
    let seen = '';
    server.use(http.get('*/api/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.activity({ limit: 5 });
    expect(seen).toBe('?limit=5');
  });

  it('usageByModel() with no args omits every query param', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.usageByModel();
    expect(seen).toBe('');
  });
  it('usageByModel(projectId, window) sends project_id + ISO from/to', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.usageByModel(2, { fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 5, 30) });
    const params = new URLSearchParams(seen);
    expect(params.get('project_id')).toBe('2');
    expect(params.get('from')).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(params.get('to')).toBe(new Date(Date.UTC(2026, 5, 30)).toISOString());
  });
  it('usageByModel(undefined, window) omits an infinite bound', async () => {
    let seen = '';
    server.use(http.get('*/api/usage/by-model', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.usageByModel(undefined, { fromMs: Date.UTC(2026, 5, 1), toMs: Infinity });
    const params = new URLSearchParams(seen);
    expect(params.has('to')).toBe(false);
    expect(params.get('from')).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
  });
});

// W4: the OrcaApiError contract is actually consumed — prefer the server's error code over the
// raw diagnostic so toasts read "forbidden", not "Error: orca 403 on /tasks".
describe('apiErrorMessage', () => {
  it('prefers the server error code on an OrcaApiError', () => {
    expect(apiErrorMessage(new OrcaApiError('orca 403 on /tasks', 403, 'forbidden'))).toBe('forbidden');
  });
  it('falls back to the message when there is no code', () => {
    expect(apiErrorMessage(new OrcaApiError('orca 500 on /tasks', 500))).toBe('orca 500 on /tasks');
  });
  it('handles plain Errors and unknown values', () => {
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
    expect(apiErrorMessage('nope')).toBe('nope');
  });
});
