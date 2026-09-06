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
  ask: 'Na čem dneska začneme?',
  pills: [{ label: 'Deploy', prompt: 'Nasaď recap pás' }],
  recaps: [
    { summary: 'Včera jste ladil **dashboard**.', suggestions: [{ label: 'Dokončit test', prompt: 'Dokonči regresní test' }] },
    { summary: 'Včera šlo hlavně o ceny.', suggestions: [{ label: 'Ceník', prompt: 'Otevři ceník' }] },
    { summary: 'Pásla jste testy.', suggestions: [{ label: 'Vitest', prompt: 'Spusť vitest' }] },
    { summary: 'Ladil se deploy.', suggestions: [{ label: 'Deploy', prompt: 'Nasaď build' }] },
    { summary: 'Četl jste logy.', suggestions: [{ label: 'Logy', prompt: 'Ukaž logy' }] },
  ],
});

function setup(opts: { reply?: string; sessions?: boolean } = {}) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const config = new ConfigStore(db);
  const dashDigests = new DashDigestStore(db);
  let calls = 0;
  const prompts: string[] = [];
  const inference = {
    model: 'test-model',
    decide: (prompt: string) => { calls += 1; prompts.push(prompt); return Promise.resolve({ text: opts.reply ?? REPLY }); },
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
    app, config, dashDigests, users, calls: () => calls, prompts: () => prompts, db,
    adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id), adminId: admin.id,
  };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const settle = () => new Promise((r) => setImmediate(r));
type Recap = {
  enabled: boolean;
  continue?: { id: string; title: string }[];
  yesterday?: { turns: number; tokens: number; sessions: string[] } | null;
  digest?: { status: string; greeting?: string; ask?: string; pills?: unknown[]; summary?: string; suggestions?: unknown[] };
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
    // The whole variant batch rides along for the client-side rotation, from the SAME generation.
    expect(second.digest?.recaps?.length).toBe(5);
    expect(second.digest?.recaps?.[1]).toEqual({ summary: 'Včera šlo hlavně o ceny.', suggestions: [{ label: 'Ceník', prompt: 'Otevři ceník' }] });
    // Greeting and pills default OFF: generated and cached, but filtered out of the response.
    expect(second.digest?.greeting).toBeUndefined();
    // The ask is part of the same agent-written hero, so the greeting toggle owns it too.
    expect(second.digest?.ask).toBeUndefined();
    expect(second.digest?.pills).toBeUndefined();
    expect(calls()).toBe(1);

    // Flipping the toggles on surfaces the cached fields WITHOUT a new inference call.
    config.update({ dashboard: { greetingEnabled: true, pillsEnabled: true } });
    const third = await getRecap(app, adminTok);
    expect(third.digest?.greeting).toBe('Čau Filipe');
    expect(third.digest?.ask).toBe('Na čem dneska začneme?');
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

  it('asks the model for 5 recap variants by default, and for the saved count once configured', async () => {
    const { app, adminTok, prompts } = setup();
    await getRecap(app, adminTok);
    await settle();
    expect(prompts()[0]).toMatch(/EXACTLY 5 recap variants/);

    // The saved count reaches the generator at the NEXT regular generation — no immediate paid run:
    // a fresh digest inside its window still costs nothing, whatever the setting says.
    expect((await getRecap(app, adminTok)).digest?.status).toBe('ready');
    expect(prompts().length).toBe(1);

    const { app: app2, adminTok: tok2, prompts: prompts2, config } = setup();
    config.update({ dashboard: { digestVariants: 3 } });
    await getRecap(app2, tok2);
    await settle();
    expect(prompts2()[0]).toMatch(/EXACTLY 3 recap variants/);
    // Per-BATCH, never the per-day frequency: digestPerDay is untouched by this field.
    expect(config.get().dashboard.digestPerDay).toBe(1);
  });

  it('clamps the stored variant count into 1–10 and keeps it distinct from digestPerDay', () => {
    const { config } = setup();
    expect(config.get().dashboard.digestVariants).toBe(5);
    expect(config.update({ dashboard: { digestVariants: 99 } }).dashboard.digestVariants).toBe(10);
    expect(config.update({ dashboard: { digestVariants: 0 } }).dashboard.digestVariants).toBe(1);
    expect(config.update({ dashboard: { digestVariants: 2.6 } }).dashboard.digestVariants).toBe(3);
    // A sibling patch without the field preserves it, exactly like every other dashboard field.
    expect(config.update({ dashboard: { digestPerDay: 4 } }).dashboard.digestVariants).toBe(3);
    expect(config.get().dashboard.digestPerDay).toBe(4);
  });

  it('serves a legacy one-variant row as recaps of one, with no migration and no new inference', async () => {
    const { app, db, adminTok, adminId, calls } = setup();
    const today = new Date().toISOString().slice(0, 10);
    // A row written by the pre-variant build: one digest, no `recaps` field in the JSON at all.
    db.prepare(
      "INSERT INTO dash_digests (user_id, day, status, payload, attempts, updated_at) VALUES (?, ?, 'ready', ?, 1, ?)",
    ).run(adminId, today, JSON.stringify({
      greeting: 'Čau Filipe', ask: 'Na čem dneska začneme?',
      summary: 'Včera jste ladil **dashboard**.', suggestions: [{ label: 'Dokončit test', prompt: 'Dokonči regresní test' }],
    }), Date.now());

    const r = await getRecap(app, adminTok);
    expect(r.digest?.status).toBe('ready');
    expect(r.digest?.summary).toBe('Včera jste ladil **dashboard**.');
    expect(r.digest?.recaps).toEqual([{
      summary: 'Včera jste ladil **dashboard**.',
      suggestions: [{ label: 'Dokončit test', prompt: 'Dokonči regresní test' }],
    }]);
    await settle();
    expect(calls()).toBe(0); // real stored data keeps serving — never regenerated away
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
