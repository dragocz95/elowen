import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { elowenClient } from '../../lib/elowenClient';

const calls: { url: string; method: string; body: unknown }[] = [];
const record = async (req: Request) => { calls.push({ url: new URL(req.url).pathname, method: req.method, body: await req.json().catch(() => null) }); };
const server = setupServer(
  http.post('*/api/sessions', async ({ request }) => { await record(request); return HttpResponse.json({ session: 'elowen-A' }, { status: 201 }); }),
  http.post('*/api/sessions/elowen-A/keys', async ({ request }) => { await record(request); return HttpResponse.json({ ok: true }); }),
  http.patch('*/api/missions/m1', async ({ request }) => { await record(request); return HttpResponse.json({ id: 'm1', state: 'paused' }); }),
  http.delete('*/api/brain/queue/:id', async ({ request }) => { await record(request); return HttpResponse.json({ removed: true }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('elowenClient mutations', () => {
  it('spawn POSTs taskId+exec to /sessions', async () => {
    const r = await elowenClient.spawn({ taskId: 'elowen-1', exec: 'sonnet' });
    expect(r.session).toBe('elowen-A');
    expect(calls.at(-1)).toMatchObject({ url: '/api/sessions', method: 'POST', body: { taskId: 'elowen-1', exec: 'sonnet' } });
  });
  it('sendKeys POSTs the keys array', async () => {
    await elowenClient.sendKeys('elowen-A', ['C-c']);
    expect(calls.at(-1)).toMatchObject({ url: '/api/sessions/elowen-A/keys', body: { keys: ['C-c'] } });
  });
  it('pauseMission PATCHes action:pause', async () => {
    await elowenClient.pauseMission('m1');
    expect(calls.at(-1)).toMatchObject({ url: '/api/missions/m1', method: 'PATCH', body: { action: 'pause' } });
  });
  it('brainQueueRemove DELETEs /brain/queue/:id and returns the result', async () => {
    const r = await elowenClient.brainQueueRemove('q-42');
    expect(r.removed).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: '/api/brain/queue/q-42', method: 'DELETE' });
  });
});
