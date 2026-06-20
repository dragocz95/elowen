import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { orcaClient, OrcaApiError, apiErrorMessage } from '../../lib/orcaClient';

const server = setupServer(
  http.get('http://localhost:4400/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'A', status: 'open' }])),
  http.get('http://localhost:4400/missions', () => new HttpResponse(null, { status: 500 })),
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
    server.use(http.get('*/tasks', () => new HttpResponse('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(orcaClient.tasks()).rejects.toBeInstanceOf(OrcaApiError);
    await expect(orcaClient.tasks()).rejects.toMatchObject({ status: 200 });
  });
  it('returns undefined on a 204 No Content without parsing', async () => {
    server.use(http.delete('*/tasks/orca-1', () => new HttpResponse(null, { status: 204 })));
    await expect(orcaClient.deleteTask('orca-1')).resolves.toBeUndefined();
  });

  // W3: with no opts the activity URL must not carry a dangling trailing '?'.
  it('activity() omits the trailing ? when no options are given', async () => {
    let seen = '';
    server.use(http.get('*/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.activity();
    expect(seen).toBe('');
  });
  it('activity({ limit }) builds a proper query string', async () => {
    let seen = '';
    server.use(http.get('*/activity', ({ request }) => { seen = new URL(request.url).search; return HttpResponse.json([]); }));
    await orcaClient.activity({ limit: 5 });
    expect(seen).toBe('?limit=5');
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
