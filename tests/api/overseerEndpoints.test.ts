import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

describe('overseer long-poll endpoints', () => {
  it('next() delivers an enqueued decision; decide() resolves the awaiting verdict', async () => {
    const { app, token, deps } = await makeTestApp({});
    const verdict = deps.decisionQueue.enqueue('m1', 'task', { title: 'risky' }, false);
    const next = await (await app.request('/missions/m1/overseer/next', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; kind: string };
    expect(next.kind).toBe('task');
    const res = await app.request('/missions/m1/overseer/decide', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: next.id, approve: true, confidence: 0.9, rationale: 'fine' }) });
    expect(res.status).toBe(200);
    await expect(verdict).resolves.toMatchObject({ approve: true, confidence: 0.9 });
  });
  it('next() returns {} heartbeat when nothing is pending', async () => {
    const { app, token } = await makeTestApp({});
    const body = await (await app.request('/missions/mX/overseer/next?timeoutMs=20', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(body).toEqual({});
  });
});
