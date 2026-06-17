import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { orcaClient } from '../../lib/orcaClient';

const calls: { url: string; method: string; body: unknown }[] = [];
const record = async (req: Request) => { calls.push({ url: new URL(req.url).pathname, method: req.method, body: await req.json().catch(() => null) }); };
const server = setupServer(
  http.post('http://localhost:4400/sessions', async ({ request }) => { await record(request); return HttpResponse.json({ session: 'orca-A' }, { status: 201 }); }),
  http.post('http://localhost:4400/sessions/orca-A/keys', async ({ request }) => { await record(request); return HttpResponse.json({ ok: true }); }),
  http.patch('http://localhost:4400/missions/m1', async ({ request }) => { await record(request); return HttpResponse.json({ id: 'm1', state: 'paused' }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('orcaClient mutations', () => {
  it('spawn POSTs taskId+exec to /sessions', async () => {
    const r = await orcaClient.spawn({ taskId: 'orca-1', exec: 'sonnet' });
    expect(r.session).toBe('orca-A');
    expect(calls.at(-1)).toMatchObject({ url: '/sessions', method: 'POST', body: { taskId: 'orca-1', exec: 'sonnet' } });
  });
  it('sendKeys POSTs the keys array', async () => {
    await orcaClient.sendKeys('orca-A', ['C-c']);
    expect(calls.at(-1)).toMatchObject({ url: '/sessions/orca-A/keys', body: { keys: ['C-c'] } });
  });
  it('pauseMission PATCHes action:pause', async () => {
    await orcaClient.pauseMission('m1');
    expect(calls.at(-1)).toMatchObject({ url: '/missions/m1', method: 'PATCH', body: { action: 'pause' } });
  });
});
