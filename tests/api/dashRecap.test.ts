import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openDb } from '../../src/store/db.js';
import { DashDigestStore } from '../../src/store/dashDigestStore.js';

/** The /dash/recap surface: strictly per-caller, lazily generated once per (user, UTC day), filtered
 *  by the admin toggles, and free for a user who has no yesterday to summarize. */

const ts = (offsetDays: number, time: string) =>
  `${new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10)} ${time}`;

const REPLY = JSON.stringify({
  greeting: 'Čau Filipe',
  pills: [{ label: 'Deploy', prompt: 'Nasaď recap pás' }],
  summary: 'Včera jste ladil **dashboard**.',
  suggestions: [{ label: 'Dokončit test', prompt: 'Dokonči regresní test' }],
});

function setup(opts: { reply?: string; sessions?: boolean } = {}) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const config = new ConfigStore(db);
  const dashDigests = new DashDigestStore(db);
  let calls = 0;
  const inference = {
    model: 'test-model',
    decide: () => { calls += 1; return Promise.resolve({ text: opts.reply ?? REPLY }); },
  };
  // The admin has a yesterday (one conversation + usage); bob has nothing at all.
  const sessions = opts.sessions === false ? [] : [
    { id: 's-live', title: 'Right now', provider: 'p', model: 'm', updated_at: ts(0, '08:00:00'), running: false, active: true, attached: 0 },
    { id: 's-y1', title: 'Vzhled dashboardu', provider: 'p', model: 'm', updated_at: ts(1, '20:00:00'), running: false, active: false, attached: 0 },
    { id: 's-old', title: 'Older thread', provider: 'p', model: 'm', updated_at: ts(5, '09:00:00'), running: false, active: false, attached: 0 },
  ];
  const brain = { listSessions: (userId: number) => (userId === admin.id ? sessions : []) };
  const brainStore = { userMessagesBetween: () => ['Udělej mi mockup dashboardu'] };
  const usageOrigins = {
    topOrigins: ({ group }: { group: string }) =>
      group === 'user' ? [{ userId: admin.id, turns: 14, tokens: 1_200_000 }] : [],
  };
  const memoryStore = { listRecent: () => [{ body: 'Prefers clean shadcn UI' }] };
  const app = createServer({
    bus: new EventBus(), project: { id: 1, path: '/o' }, clock: new FakeClock(0),
    config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    brain: brain as never, brainStore: brainStore as never,
    usageOrigins: usageOrigins as never, memoryStore: memoryStore as never,
    dashDigests, dashDigestInference: () => inference,
  });
  return {
    app, config, dashDigests, users, calls: () => calls,
    adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id), adminId: admin.id,
  };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const settle = () => new Promise((r) => setImmediate(r));
type Recap = {
  enabled: boolean;
  continue?: { id: string; title: string }[];
  yesterday?: { turns: number; tokens: number; sessions: string[] } | null;
  digest?: { status: string; greeting?: string; pills?: unknown[]; summary?: string; suggestions?: unknown[] };
};
const getRecap = async (app: ReturnType<typeof setup>['app'], tok: string): Promise<Recap> =>
  (await (await app.request('/dash/recap', auth(tok))).json()) as Recap;

describe('GET /dash/recap', () => {
  it('requires authentication', async () => {
    const { app } = setup();
    expect((await app.request('/dash/recap')).status).toBe(401);
  });

  it('reports {enabled:false} and never generates when the recap is switched off', async () => {
    const { app, config, adminTok, calls } = setup();
    config.update({ dashboard: { recapEnabled: false } });
    expect(await getRecap(app, adminTok)).toEqual({ enabled: false });
    await settle();
    expect(calls()).toBe(0);
  });

  it('generates once per day, serves the cache after, and filters greeting/pills by the toggles', async () => {
    const { app, config, adminTok, calls } = setup();
    const first = await getRecap(app, adminTok);
    expect(first.digest?.status).toBe('generating');
    expect(first.yesterday).toEqual({ turns: 14, tokens: 1_200_000, sessions: ['Vzhled dashboardu'] });
    // The active conversation is not a "continue" target; the two others are.
    expect(first.continue?.map((s) => s.id)).toEqual(['s-y1', 's-old']);
    await settle();

    const second = await getRecap(app, adminTok);
    expect(second.digest?.status).toBe('ready');
    expect(second.digest?.summary).toBe('Včera jste ladil **dashboard**.');
    expect(second.digest?.suggestions?.length).toBe(1);
    // Greeting and pills default OFF: generated and cached, but filtered out of the response.
    expect(second.digest?.greeting).toBeUndefined();
    expect(second.digest?.pills).toBeUndefined();
    expect(calls()).toBe(1);

    // Flipping the toggles on surfaces the cached fields WITHOUT a new inference call.
    config.update({ dashboard: { greetingEnabled: true, pillsEnabled: true } });
    const third = await getRecap(app, adminTok);
    expect(third.digest?.greeting).toBe('Čau Filipe');
    expect(third.digest?.pills).toEqual([{ label: 'Deploy', prompt: 'Nasaď recap pás' }]);
    expect(calls()).toBe(1);
  });

  it('refreshes within the day only once the configured window elapsed, still serving the old digest', async () => {
    const { app, config, dashDigests, adminTok, adminId, calls } = setup();
    const today = new Date().toISOString().slice(0, 10);
    await getRecap(app, adminTok);
    await settle();
    expect(calls()).toBe(1);

    // Age the stored digest by seven hours by rewriting its completion time.
    const age = (hoursAgo: number) => {
      const row = dashDigests.get(adminId, today)!;
      dashDigests.complete(adminId, today, row.payload, Date.now() - hoursAgo * 3_600_000);
    };

    // Default is one run a day: a seven-hour-old digest is still this day's digest.
    age(7);
    await getRecap(app, adminTok);
    await settle();
    expect(calls()).toBe(1);

    // Four runs a day puts the window at six hours, so the same row is now due.
    config.update({ dashboard: { digestPerDay: 4 } });
    age(7);
    const during = await getRecap(app, adminTok);
    expect(during.digest?.status).toBe('ready');
    expect(during.digest?.summary).toBe('Včera jste ladil **dashboard**.');
    await settle();
    expect(calls()).toBe(2);
  });

  it('never spends a token on a user with no yesterday', async () => {
    const { app, bobTok, calls } = setup();
    const r = await getRecap(app, bobTok);
    expect(r.yesterday).toBeNull();
    expect(r.digest?.status).toBe('unavailable');
    await settle();
    expect(calls()).toBe(0);
  });

  it('digestEnabled=false keeps the deterministic layer and skips generation', async () => {
    const { app, config, adminTok, calls } = setup();
    config.update({ dashboard: { digestEnabled: false } });
    const r = await getRecap(app, adminTok);
    expect(r.digest?.status).toBe('unavailable');
    expect(r.yesterday?.turns).toBe(14);
    await settle();
    expect(calls()).toBe(0);
  });

  it('a malformed model reply lands as unavailable, not as a crash or an empty digest', async () => {
    const { app, adminTok, calls } = setup({ reply: 'sorry, I cannot' });
    await getRecap(app, adminTok);
    await settle();
    const r = await getRecap(app, adminTok);
    expect(r.digest?.status).toBe('unavailable');
    expect(calls()).toBe(1); // failed row cools down — no immediate second attempt
  });

  it('continueEnabled=false drops the continue pills only', async () => {
    const { app, config, adminTok } = setup();
    config.update({ dashboard: { continueEnabled: false } });
    const r = await getRecap(app, adminTok);
    expect(r.continue).toEqual([]);
    expect(r.yesterday?.turns).toBe(14);
  });
});

describe('POST /dash/recap/regenerate', () => {
  it('is admin-only and self-scoped: dropping today\'s row makes the next GET generate again', async () => {
    const { app, adminTok, bobTok, calls } = setup();
    await getRecap(app, adminTok);
    await settle();
    expect(calls()).toBe(1);

    expect((await app.request('/dash/recap/regenerate', { method: 'POST', ...auth(bobTok) })).status).toBe(403);
    expect((await app.request('/dash/recap/regenerate', { method: 'POST', ...auth(adminTok) })).status).toBe(200);

    await getRecap(app, adminTok);
    await settle();
    expect(calls()).toBe(2);
  });
});
