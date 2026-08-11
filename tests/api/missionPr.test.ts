import { describe, it, expect, vi } from 'vitest';
import { MissionPrStore } from '../../plugins/agents/src/store/missionPrStore.js';
import { makeTestApp } from '../helpers/testApp.js';
import type { FinishResult } from '../../plugins/agents/src/overseer/missionGit.js';

/** An app + a seeded epic/mission, with the runtime's REAL MissionGit's `openPr` stubbed to the given
 *  outcome — the routes are plugin-served, so the stub lands on the exact instance the handler calls. */
async function build(openPr: () => Promise<FinishResult>) {
  const t = await makeTestApp();
  t.deps.tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  t.deps.missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
  vi.spyOn(t.control.missionGit(), 'openPr').mockImplementation(openPr as never);
  return t;
}
const openPr = (t: Awaited<ReturnType<typeof build>>, id = 'm-epic') =>
  t.app.request(`/missions/${id}/pr`, { method: 'POST', headers: { authorization: `Bearer ${t.token}` } });

describe('POST /missions/:id/pr', () => {
  it('returns the PR url + number when openPr opens one', async () => {
    const t = await build(async () => ({ state: 'opened', url: 'https://github.com/o/r/pull/3', number: 3 }));
    const res = await openPr(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://github.com/o/r/pull/3', number: 3 });
  });

  it('maps a failed verify gate to 422 with its output', async () => {
    const t = await build(async () => ({ state: 'verify-failed', output: 'tests failed' }));
    const res = await openPr(t);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ output: 'tests failed' });
  });

  it('maps a missing remote to 422', async () => {
    const t = await build(async () => ({ state: 'no-remote' }));
    expect((await openPr(t)).status).toBe(422);
  });

  it('maps an unfinished mission (incomplete) to 409', async () => {
    const t = await build(async () => ({ state: 'incomplete' }));
    expect((await openPr(t)).status).toBe(409);
  });

  it('404s for an unknown mission', async () => {
    const t = await build(async () => ({ state: 'off' }));
    expect((await openPr(t, 'm-nope')).status).toBe(404);
  });

  it('400s when the PR workflow is not enabled for the mission', async () => {
    const t = await build(async () => ({ state: 'off' }));
    expect((await openPr(t)).status).toBe(400);
  });
});

describe('GET /missions surfaces a completed PR-native mission', () => {
  // The pr rows are written into the SHARED :memory: DB — the plugin runtime's MissionGit reads the
  // same table, so the list route surfaces them exactly as the daemon would.
  const seedDisengagedWithPr = (t: Awaited<ReturnType<typeof makeTestApp>>) => {
    t.deps.tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    t.deps.missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    t.deps.missions.setState('m-epic', 'disengaged'); // naturally completed → drops out of live()
    const prs = new MissionPrStore(t.db);
    prs.create({ mission_id: 'm-epic', branch: 'elowen/demo-epic', worktree: '/wt' });
    return prs;
  };
  const list = async (t: Awaited<ReturnType<typeof makeTestApp>>) =>
    (await (await t.app.request('/missions', { headers: { authorization: `Bearer ${t.token}` } })).json()) as { id: string; state: string; pr: { branch: string } | null }[];

  it('includes a DISENGAGED mission with a pending PR (so the Open PR affordance survives completion)', async () => {
    const t = await makeTestApp();
    seedDisengagedWithPr(t); // pr pending (no url yet)
    const m = (await list(t)).find((x) => x.id === 'm-epic');
    expect(m).toBeTruthy();
    expect(m!.state).toBe('disengaged');
    expect(m!.pr?.branch).toBe('elowen/demo-epic');
  });

  it('drops a mission once its PR is merged', async () => {
    const t = await makeTestApp();
    const prs = seedDisengagedWithPr(t);
    prs.setPr('m-epic', { number: 1, url: 'u', state: 'merged' });
    expect((await list(t)).find((x) => x.id === 'm-epic')).toBeUndefined(); // merged → no longer surfaced
  });
});
