import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8'], apiKey: 'k' }] } });
  const restart = vi.fn(async () => {});
  const applyUserInstructionsChange = vi.fn(async () => {});
  const applyAutoCompactSettings = vi.fn();
  const app = createServer({
    bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    userSettings: new UserSettingStore(db),
    brain: { restart, applyUserInstructionsChange, applyAutoCompactSettings } as never,
  });
  return { app, restart, applyUserInstructionsChange, applyAutoCompactSettings, users, config, amyId: amy.id, amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('cli-settings routes', () => {
  it('GET returns defaults + the server default model', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', auth(amyTok));
    expect(res.status).toBe(200);
    // `availableLinks` is EMPTY here on purpose: this fixture registers no platform adapter, and the
    // account page offers a platform link only where a sender could actually arrive. An empty array is
    // therefore the honest answer and must not be confused with the field being absent, which is how an
    // older daemon reads and which means "offer all of them".
    expect(await res.json()).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 80, autoCompactAtByModel: {}, projectModelPreferences: {}, advisorStyle: 'concise', personalityBody: '', userInstructions: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', msteamsUserId: '', autoRecall: true, autoLiveRecall: true, autoSave: false, fastMode: false, serverDefault: 'claude-opus-4-8', serverDefaultRoute: { provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-4-8' }, availableLinks: [], revision: 0 });
  });

  it('PATCH saves the override and restarts a running brain', async () => {
    const { app, restart, applyAutoCompactSettings, amyId, amyTok, config } = setup();
    // The pair has to name a model this installation actually has: a brain model that is not in Settings →
    // Brain is refused for everyone, admin included (existence is not a permission — shared/execs.ts). The
    // first model stays `claude-opus-4-8` so `serverDefault` is unchanged by the fixture.
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8', 'ollama/kimi-k2.7-code'], apiKey: 'k' }] } });
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', autoCompact: true, autoCompactAt: 70 }));
    expect(await res.json()).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, autoCompactAtByModel: {}, projectModelPreferences: {}, advisorStyle: 'concise', personalityBody: '', userInstructions: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', msteamsUserId: '', autoRecall: true, autoLiveRecall: true, autoSave: false, fastMode: false, serverDefault: 'claude-opus-4-8', serverDefaultRoute: { provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-4-8' }, revision: 1 });
    expect(restart).toHaveBeenCalledTimes(1);
    // The threshold also reaches conversations that are ALREADY live — the restart above only covers this
    // user's active chat, not their other sessions or the channel sessions they own.
    expect(applyAutoCompactSettings).toHaveBeenCalledWith(amyId);
  });

  it('PATCH persists the account Fast preference without restarting live sessions', async () => {
    const { app, restart, applyAutoCompactSettings, amyTok } = setup();
    const enabled = await app.request('/auth/me/cli-settings', patch(amyTok, { fastMode: true }));
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).fastMode).toBe(true);

    const reloaded = await app.request('/auth/me/cli-settings', auth(amyTok));
    expect((await reloaded.json()).fastMode).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(applyAutoCompactSettings).not.toHaveBeenCalled();
  });

  it('PATCH saves userInstructions, keeps the legacy alias, and applies it on every surface', async () => {
    const { app, restart, applyUserInstructionsChange, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, {
      userInstructions: 'Be concise.', personalityBody: 'legacy must lose',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userInstructions: 'Be concise.', personalityBody: 'Be concise.' });
    expect(applyUserInstructionsChange).toHaveBeenCalledTimes(1); // drops channel sessions so the instructions reach Discord
    expect(restart).not.toHaveBeenCalled(); // the scoped re-apply already restarts owner chat
  });

  it('still accepts personalityBody from an older client', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/auth/me/cli-settings', patch(amyTok, { personalityBody: 'Legacy client.' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userInstructions: 'Legacy client.', personalityBody: 'Legacy client.' });
  });

  it('PATCH returns as soon as the setting is persisted, without blocking on the live brain re-apply', async () => {
    // Regression: applyUserInstructionsChange/restart respawns the brain and waits for any in-flight turn to
    // settle, so awaiting it in the request stalled the PATCH (and the web "saving" indicator) for as long
    // as the turn ran. A never-settling re-apply must not hang the response — the persist already happened.
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8'], apiKey: 'k' }] } });
    const applyUserInstructionsChange = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const app = createServer({
      bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      userSettings: new UserSettingStore(db),
      brain: { restart: vi.fn(async () => {}), applyUserInstructionsChange, applyAutoCompactSettings: vi.fn() } as never,
    });
    const res = await app.request('/auth/me/cli-settings', patch(users.issueToken(amy.id), { userInstructions: 'Be concise.' }));
    expect(res.status).toBe(200);
    expect((await res.json()).userInstructions).toBe('Be concise.'); // persisted, even though the re-apply is still pending
    expect(applyUserInstructionsChange).toHaveBeenCalledTimes(1); // fired, just not awaited
  });

  it('PATCH accepts any configured brain model for a non-admin, but a personal allow-list still narrows it', async () => {
    const { app, users, config } = setup();
    // These two cases turn on the brain bypass, which only applies to a CONFIGURED provider.
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi', 'glm'], apiKey: 'k' }] } });
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
    const { app, users, config } = setup();
    // These two cases turn on the brain bypass, which only applies to a CONFIGURED provider.
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi', 'glm'], apiKey: 'k' }] } });
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

  // Account → Models shows the pins `switchModel` writes implicitly and offers to clear them. Reading them
  // needs GET to publish the map; clearing one needs PATCH to accept the map back, minus the dropped entry.
  it('GET publishes the per-project model pins and PATCH clears one by replacing the map', async () => {
    const { app, amyTok, config } = setup();
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8', 'glm'], apiKey: 'k' }] } });
    const written = await app.request('/auth/me/cli-settings', patch(amyTok, {
      projectModelPreferences: { '/var/www/kolin': { provider: 'relay', model: 'glm' }, '/var/www/elowen': { provider: 'relay', model: 'claude-opus-4-8' } },
    }));
    expect(written.status).toBe(200);
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).projectModelPreferences).toEqual({
      '/var/www/kolin': { provider: 'relay', model: 'glm' },
      '/var/www/elowen': { provider: 'relay', model: 'claude-opus-4-8' },
    });
    // Clearing is the same write with the entry left out — the map replaces wholesale.
    await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: { '/var/www/kolin': { provider: 'relay', model: 'glm' } } }));
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).projectModelPreferences).toEqual({
      '/var/www/kolin': { provider: 'relay', model: 'glm' },
    });
    // …and an empty map clears every pin.
    await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: {} }));
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).projectModelPreferences).toEqual({});
  });

  it('PATCH judges every surviving project pin against the personal allow-list', async () => {
    const { app, users, config } = setup();
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi', 'glm'], apiKey: 'k' }] } });
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    users.setAllowedExecs(bob.id, ['elowen:relay/glm']);
    // A pin naming a model this account may NOT run is refused outright — the map cannot widen the list.
    const refused = await app.request('/auth/me/cli-settings', patch(bobTok, { projectModelPreferences: { '/p': { provider: 'relay', model: 'kimi' } } }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("'/p'");
    expect((await app.request('/auth/me/cli-settings', auth(bobTok)).then((r) => r.json())).projectModelPreferences).toEqual({});
    // An allowed one goes through.
    expect((await app.request('/auth/me/cli-settings', patch(bobTok, { projectModelPreferences: { '/p': { provider: 'relay', model: 'glm' } } }))).status).toBe(200);
  });

  /** The map REPLACES the stored one, so dropping a malformed entry and saving the survivors turns a
   *  garbled payload into `{}` — every pin the user has, wiped, and reported as a successful save. The
   *  boundary rejects and writes NOTHING. */
  it('PATCH refuses a malformed project pin instead of silently wiping the stored map', async () => {
    const { app, amyTok, config } = setup();
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8', 'glm'], apiKey: 'k' }] } });
    const stored = { '/var/www/kolin': { provider: 'relay', model: 'glm' } };
    expect((await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: stored }))).status).toBe(200);

    for (const bad of [
      { '/a': { provider: 'relay' } },                  // half an entry
      { '/a': { provider: 'relay', model: '   ' } },    // blank after trimming
      { '/a': 'relay/glm' },                            // not an object
      { '': { provider: 'relay', model: 'glm' } },      // no project root
      { '/a': null },
    ]) {
      const res = await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toContain('projectModelPreferences');
    }
    // …and a payload that is not a map at all.
    expect((await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: ['/a'] }))).status).toBe(400);
    expect((await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: 'nope' }))).status).toBe(400);

    // None of them wrote anything.
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).projectModelPreferences).toEqual(stored);
  });

  it('PATCH refuses a mixed valid/invalid pin map whole, keeping the stored pins intact', async () => {
    const { app, amyTok, config } = setup();
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8', 'glm'], apiKey: 'k' }] } });
    const stored = { '/var/www/kolin': { provider: 'relay', model: 'glm' } };
    await app.request('/auth/me/cli-settings', patch(amyTok, { projectModelPreferences: stored }));

    const res = await app.request('/auth/me/cli-settings', patch(amyTok, {
      projectModelPreferences: { '/var/www/kolin': { provider: 'relay', model: 'glm' }, '/var/www/broken': { provider: 'relay', model: '' } },
    }));
    expect(res.status).toBe(400);
    expect((await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json())).projectModelPreferences).toEqual(stored);
  });

  /** The instance default is what an EMPTY personal model resolves to, and the runtime applies it to a
   *  member whose own allow-list does not name it (`selectionAllowed` judges COMPLETE selections only).
   *  Filtering it by the caller would leave that member's account page saying "Inherited" and nothing else. */
  it('GET reports the instance default even when the caller may not run it', async () => {
    const { app, users, config } = setup();
    config.update({ brain: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['claude-opus-4-8', 'glm'], apiKey: 'k' }] } });
    const bob = users.create('bob', 'pw');
    users.setAllowedExecs(bob.id, ['elowen:relay/glm']); // NOT the default
    const body = await app.request('/auth/me/cli-settings', auth(users.issueToken(bob.id))).then((r) => r.json());
    expect(body.serverDefaultRoute).toEqual({ provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-4-8' });
    expect(body.serverDefault).toBe('claude-opus-4-8');
  });

  /** A bare connected OAuth account carries no manual model list, and the runtime then starts on the
   *  provider CATALOG's default. Reading `providers[0].models[0]` reported nothing at all here, so the
   *  row this feeds would have shown an em dash while conversations ran perfectly well. */
  it('GET resolves the instance default from the provider catalog when no model list is configured', async () => {
    const { app, amyTok, config } = setup();
    config.update({ brain: { providers: [{ id: 'claude', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: '' }] } });
    const body = await app.request('/auth/me/cli-settings', auth(amyTok)).then((r) => r.json());
    expect(body.serverDefaultRoute?.provider).toBe('claude');
    // Whatever the catalog's own default is, it has to be a real model id rather than the empty list.
    expect(body.serverDefaultRoute?.model).toBeTruthy();
    expect(body.serverDefault).toBe(body.serverDefaultRoute.model);
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

  it('PATCH refuses a Teams identity already linked to another user (409)', async () => {
    const { app, users, amyTok } = setup();
    const bob = users.create('bob', 'pw');
    const bobTok = users.issueToken(bob.id);
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect((await app.request('/auth/me/cli-settings', patch(amyTok, { msteamsUserId: id }))).status).toBe(200);
    const res = await app.request('/auth/me/cli-settings', patch(bobTok, { msteamsUserId: id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Microsoft Teams');
  });
});
