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
  return { app, restart, amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('cli-settings routes', () => {
  it('GET returns defaults + the server default model', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: '', autoCompact: false, autoCompactAt: 80, serverDefault: 'claude-opus-4-8' });
  });

  it('PATCH saves the override and restarts a running brain', async () => {
    const { app, restart, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { model: 'ollama/kimi-k2.7-code', autoCompact: true, autoCompactAt: 70 }));
    expect(await res.json()).toEqual({ model: 'ollama/kimi-k2.7-code', autoCompact: true, autoCompactAt: 70, serverDefault: 'claude-opus-4-8' });
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
