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
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  config.update({ autopilot: { model: 'claude-opus-4-8' } });
  const restart = vi.fn(async () => {});
  const applyPersonalityChange = vi.fn(async () => {});
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    userSettings: new UserSettingStore(db),
    brain: { restart, applyPersonalityChange } as never,
  });
  return { app, restart, applyPersonalityChange, users, config, amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('cli-settings routes', () => {
  it('GET returns defaults + the server default model', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true, serverDefault: 'claude-opus-4-8' });
  });

  it('PATCH saves the override and restarts a running brain', async () => {
    const { app, restart, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', autoCompact: true, autoCompactAt: 70 }));
    expect(await res.json()).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true, serverDefault: 'claude-opus-4-8' });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('PATCH saves the personality body and applies it via applyPersonalityChange (not a plain restart)', async () => {
    const { app, restart, applyPersonalityChange, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { personalityBody: 'Be concise.' }));
    expect(res.status).toBe(200);
    expect((await res.json()).personalityBody).toBe('Be concise.');
    expect(applyPersonalityChange).toHaveBeenCalledTimes(1); // drops channel sessions so the global body reaches Discord
    expect(restart).not.toHaveBeenCalled(); // applyPersonalityChange already restarts owner chat — no double restart
  });

  it('PATCH returns as soon as the setting is persisted, without blocking on the live brain re-apply', async () => {
    // Regression: applyPersonalityChange/restart respawns the brain and waits for any in-flight turn to
    // settle, so awaiting it in the request stalled the PATCH (and the web "saving" indicator) for as long
    // as the turn ran. A never-settling re-apply must not hang the response — the persist already happened.
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    config.update({ autopilot: { model: 'claude-opus-4-8' } });
    const applyPersonalityChange = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      userSettings: new UserSettingStore(db),
      brain: { restart: vi.fn(async () => {}), applyPersonalityChange } as never,
    });
    const res = await app.request('/auth/me/cli-settings', patch(users.issueToken(amy.id), { personalityBody: 'Be concise.' }));
    expect(res.status).toBe(200);
    expect((await res.json()).personalityBody).toBe('Be concise.'); // persisted, even though the re-apply is still pending
    expect(applyPersonalityChange).toHaveBeenCalledTimes(1); // fired, just not awaited
  });

  it('PATCH accepts any configured brain model for a non-admin, but a personal allow-list still narrows it', async () => {
    const { app, users } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    // `elowen:relay/kimi` is a brain exec — bounded by configured providers, not the global CLI allow-list —
    // so an unrestricted non-admin may select it (guards the empty-picker bug).
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { model: 'kimi', modelProvider: 'relay' }))).status).toBe(200);
    // A personal allow-list that EXCLUDES it → 400.
    users.setAllowedExecs(bob.id, ['elowen:relay/glm']);
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { model: 'kimi', modelProvider: 'relay' }))).status).toBe(400);
    // …and one that INCLUDES it → 200.
    users.setAllowedExecs(bob.id, ['elowen:relay/kimi']);
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { model: 'kimi', modelProvider: 'relay' }))).status).toBe(200);
    // Clearing the override is always fine.
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { model: '', modelProvider: '' }))).status).toBe(200);
  });

  it('PATCH persists the compaction-model pair and enforces the personal allow-list', async () => {
    const { app, users } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    // An unrestricted non-admin may set any configured brain exec as their compaction model.
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { compactModel: 'kimi', compactModelProvider: 'relay' }))).status).toBe(200);
    expect((await app.request('/auth/me/cli-settings', auth(bobTok)).then((r) => r.json())).compactModel).toBe('kimi');
    // A personal allow-list that EXCLUDES it → 400.
    users.setAllowedExecs(bob.id, ['elowen:relay/glm']);
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { compactModel: 'kimi', compactModelProvider: 'relay' }))).status).toBe(400);
    // Clearing the override is always fine.
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { compactModel: '', compactModelProvider: '' }))).status).toBe(200);
  });

  it('PATCH persists the per-model auto-compact threshold map (clamped)', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { autoCompactAtByModel: { 'relay/gpt-x': 65, 'ant/claude-x': 200 } }));
    expect(res.status).toBe(200);
    // Stored and echoed back, with each value clamped into the 30–95 band.
    expect((await res.json()).autoCompactAtByModel).toEqual({ 'relay/gpt-x': 65, 'ant/claude-x': 95 });
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
