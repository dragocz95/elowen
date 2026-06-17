import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { orcaClient } from '../../lib/orcaClient';
import { getToken, setToken, clearToken } from '../../lib/token';

const server = setupServer();
beforeAll(() => server.listen()); afterEach(() => { server.resetHandlers(); clearToken(); }); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

describe('orcaClient auth', () => {
  it('attaches the Bearer header when a token is present', async () => {
    setToken('tok123');
    let seen: string | null = null;
    server.use(http.get('*/tasks', ({ request }) => { seen = request.headers.get('authorization'); return HttpResponse.json([]); }));
    await orcaClient.tasks();
    expect(seen).toBe('Bearer tok123');
  });
  it('clears the token on a 401', async () => {
    setToken('stale');
    server.use(http.get('*/tasks', () => new HttpResponse(null, { status: 401 })));
    await expect(orcaClient.tasks()).rejects.toBeTruthy();
    expect(getToken()).toBeNull();
  });
  it('login posts creds and returns token+user', async () => {
    server.use(http.post('*/auth/login', () => HttpResponse.json({ token: 't', user: { id: 1, username: 'alice', created_at: 'now' } })));
    const r = await orcaClient.login('alice', 'secret');
    expect(r.token).toBe('t');
    expect(r.user.username).toBe('alice');
  });
});
