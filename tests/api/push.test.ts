import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { PushSubscriptionStore } from '../../src/store/pushSubscriptionStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const bob = users.create('bob', 'pw');
  const mallory = users.create('mallory', 'pw');
  const config = new ConfigStore(db);
  config.setWebPushKeys({ publicKey: 'pub-123', privateKey: 'priv-123' });
  const pushSubscriptions = new PushSubscriptionStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), pushSubscriptions,
  });
  return { app, pushSubscriptions, bob, bobTok: users.issueToken(bob.id), malloryTok: users.issueToken(mallory.id) };
}
const post = (t: string | null, body: unknown) => ({
  method: 'POST',
  headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const validSub = { endpoint: 'https://push/abc', keys: { p256dh: 'p', auth: 'a' } };

describe('GET /push/vapid-public-key', () => {
  it('returns the configured public key without auth', async () => {
    const { app } = setup();
    const res = await app.request('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'pub-123' });
  });
});

describe('POST /push/subscribe', () => {
  it('stores a valid subscription for the authed user', async () => {
    const { app, pushSubscriptions, bob, bobTok } = setup();
    const res = await app.request('/push/subscribe', post(bobTok, validSub));
    expect(res.status).toBe(201);
    expect(pushSubscriptions.listForUsers([bob.id]).map((r) => r.endpoint)).toEqual(['https://push/abc']);
  });
  it('rejects a malformed body with 400', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/push/subscribe', post(bobTok, { endpoint: 'x' }))).status).toBe(400);
  });
  it('rejects an unauthenticated request with 401', async () => {
    const { app } = setup();
    expect((await app.request('/push/subscribe', post(null, validSub))).status).toBe(401);
  });
});

describe('POST /push/unsubscribe', () => {
  it('removes a stored subscription', async () => {
    const { app, pushSubscriptions, bob, bobTok } = setup();
    await app.request('/push/subscribe', post(bobTok, validSub));
    const res = await app.request('/push/unsubscribe', post(bobTok, { endpoint: 'https://push/abc' }));
    expect(res.status).toBe(200);
    expect(pushSubscriptions.listForUsers([bob.id])).toHaveLength(0);
  });
  it('does not let another user remove your device by guessing the endpoint', async () => {
    const { app, pushSubscriptions, bob, bobTok, malloryTok } = setup();
    await app.request('/push/subscribe', post(bobTok, validSub));
    await app.request('/push/unsubscribe', post(malloryTok, { endpoint: 'https://push/abc' }));
    expect(pushSubscriptions.listForUsers([bob.id])).toHaveLength(1); // bob's device survives
  });
});
