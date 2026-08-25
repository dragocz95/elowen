import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { elowenClient } from '../../lib/elowenClient';

const calls: { url: string; method: string; body: unknown }[] = [];
const record = async (req: Request) => { calls.push({ url: new URL(req.url).pathname, method: req.method, body: await req.json().catch(() => null) }); };
const server = setupServer(
  http.delete('*/api/brain/queue/:id', async ({ request }) => { await record(request); return HttpResponse.json({ removed: true }); }),
  http.patch('*/api/brain/sessions/:id', async ({ request, params }) => { await record(request); return HttpResponse.json({ id: params['id'], title: 'Renamed' }); }),
  http.post('*/api/brain/send', async ({ request }) => { await record(request); return HttpResponse.json({ ok: true }, { status: 202 }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('elowenClient mutations', () => {
  it('brainQueueRemove DELETEs /brain/queue/:id and returns the result', async () => {
    const r = await elowenClient.brainQueueRemove('q-42');
    expect(r.removed).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: '/api/brain/queue/q-42', method: 'DELETE' });
  });
  it('brainRenameSession PATCHes /brain/sessions/:id with a JSON title body', async () => {
    const r = await elowenClient.brainRenameSession('brain-9', 'New title');
    expect(r).toMatchObject({ id: 'brain-9', title: 'Renamed' });
    expect(calls.at(-1)).toMatchObject({ url: '/api/brain/sessions/brain-9', method: 'PATCH', body: { title: 'New title' } });
  });
  it('brainSend stamps the work mode on the turn (and omits it when none is given)', async () => {
    await elowenClient.brainSend('outline it', undefined, undefined, { session: 'brain-9' }, 'plan');
    expect(calls.at(-1)).toMatchObject({ url: '/api/brain/send', method: 'POST', body: { text: 'outline it', session: 'brain-9', mode: 'plan' } });
    await elowenClient.brainSend('hi');
    expect((calls.at(-1)?.body as Record<string, unknown>)['mode']).toBeUndefined();
  });
});
