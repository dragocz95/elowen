import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  config.update({ autopilot: { model: 'claude-opus-4-8' } });
  const restart = vi.fn(async () => {});
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    userSettings: new UserSettingStore(db),
    brain: { restart } as never,
  });
  return { app, restart, users, config, amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('cli-settings routes', () => {
  it('GET returns defaults + the server default model', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true, serverDefault: 'claude-opus-4-8' });
  });

  it('PATCH saves the override and restarts a running brain', async () => {
    const { app, restart, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', autoCompact: true, autoCompactAt: 70 }));
    expect(await res.json()).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true, serverDefault: 'claude-opus-4-8' });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('PATCH rejects a model outside a non-admin caller allow-list, accepts an allowed one', async () => {
    const { app, users, config } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    // Not on the global list → 400, nothing saved.
    const denied = await app.request('/auth/me/cli-settings', patch(bobTok, { model: 'kimi', modelProvider: 'relay' }));
    expect(denied.status).toBe(400);
    // Admin allows it globally → save succeeds.
    config.update({ allowedExecs: ['orca:relay/kimi'] } as never);
    const ok = await app.request('/auth/me/cli-settings', patch(bobTok, { model: 'kimi', modelProvider: 'relay' }));
    expect(ok.status).toBe(200);
    // Clearing the override is always fine.
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { model: '', modelProvider: '' }))).status).toBe(200);
  });

  it('PATCH refuses a Discord id already linked to another user (409, no override)', async () => {
    const { app, users, amyTok } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    // Amy links the snowflake first.
    expect((await app.request('/auth/me/cli-settings', patch(amyTok, { discordUserId: '123456789012345678' }))).status).toBe(200);
    // Bob tries to squat the same id → 409, and his link stays empty.
    const res = await app.request('/auth/me/cli-settings', patch(bobTok, { discordUserId: '123456789012345678' }));
    expect(res.status).toBe(409);
    expect((await app.request('/auth/me/cli-settings', auth(bobTok)).then((r) => r.json())).discordUserId).toBe('');
    // Amy still owns it.
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).discordUserId).toBe('123456789012345678');
  });
});
