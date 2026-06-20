import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

describe('post-done review', () => {
  it('enqueues a review decision when a mission phase closes and reviewOnDone+overseerExec set', async () => {
    const { app, token, deps } = await makeTestApp({});
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { overseerExec: 'claude:opus', reviewOnDone: true } }) });
    const { missionId, childId } = deps.seedMissionWithChild();
    const poll = deps.decisionQueue.next(missionId, 2000);
    await app.request(`/tasks/${childId}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', outcome: 'ok', result_summary: 'done' }) });
    const req = await poll;
    expect(req?.kind).toBe('review');
  });

  it('does not enqueue a review when reviewOnDone is false (default)', async () => {
    const { app, token, deps } = await makeTestApp({});
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { overseerExec: 'claude:opus' } }) });
    const { missionId, childId } = deps.seedMissionWithChild();
    const poll = deps.decisionQueue.next(missionId, 300);
    await app.request(`/tasks/${childId}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', outcome: 'ok' }) });
    expect(await poll).toBeNull();
  });
});
