import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

let db: Db;
let cfg: ConfigStore;
beforeEach(() => { db = openDb(':memory:'); cfg = new ConfigStore(db); });

describe('ConfigStore', () => {
  it('returns defaults when empty (all execs allowed, key unset, customModels empty)', () => {
    const c = cfg.get();
    expect(c.allowedExecs).toContain('sonnet');
    expect(c.allowedExecs.length).toBe(11);
    expect(c.autopilot.apiKeySet).toBe(false);
    expect(c.customModels).toEqual([]);
  });
  it('update merges allowedExecs + autopilot and never returns the raw key', () => {
    const c = cfg.update({ allowedExecs: ['sonnet'], autopilot: { model: 'gpt-5.5', apiKey: 'secret-key' } });
    expect(c.allowedExecs).toEqual(['sonnet']);
    expect(c.autopilot.model).toBe('gpt-5.5');
    expect(c.autopilot.apiKeySet).toBe(true);
    expect(JSON.stringify(c)).not.toContain('secret-key');
    expect(cfg.apiKey()).toBe('secret-key');
  });
  it('tddMode round-trips, defaults off, and a partial patch preserves siblings', () => {
    expect(cfg.get().autopilot.tddMode).toBe(false); // default off
    cfg.update({ autopilot: { reviewOnDone: true } });
    cfg.update({ autopilot: { tddMode: true } });
    const c = cfg.get();
    expect(c.autopilot.tddMode).toBe(true);
    expect(c.autopilot.reviewOnDone).toBe(true); // the tddMode patch left the sibling alone
    // Flipping it back off round-trips too, without disturbing reviewOnDone.
    const c2 = cfg.update({ autopilot: { tddMode: false } });
    expect(c2.autopilot.tddMode).toBe(false);
    expect(c2.autopilot.reviewOnDone).toBe(true);
  });
  it('update without apiKey keeps the existing key', () => {
    cfg.update({ autopilot: { apiKey: 'k1' } });
    cfg.update({ autopilot: { model: 'x' } });
    expect(cfg.apiKey()).toBe('k1');
    expect(cfg.get().autopilot.apiKeySet).toBe(true);
  });
  it('brain.hiddenOauth defaults empty, sanitizes, survives a sibling patch, and clears on an empty list', () => {
    expect(cfg.get().brain.hiddenOauth).toEqual([]);
    // Non-string / empty members are dropped on the way in.
    cfg.update({ brain: { hiddenOauth: ['oauth-kimi', 42, '', 'oauth-anthropic'] as unknown as string[] } });
    expect(cfg.get().brain.hiddenOauth).toEqual(['oauth-kimi', 'oauth-anthropic']);
    // A patch touching another brain field must not reset the hidden list.
    cfg.update({ brain: { agentName: 'Bot' } });
    expect(cfg.get().brain.hiddenOauth).toEqual(['oauth-kimi', 'oauth-anthropic']);
    // An explicit empty list clears it (un-hiding the last account).
    cfg.update({ brain: { hiddenOauth: [] } });
    expect(cfg.get().brain.hiddenOauth).toEqual([]);
  });

  describe('autopilotRelay (planner/overseer/curator credentials)', () => {
    it('falls back to the legacy top-level apiKey + autopilot.apiUrl when no provider is picked', () => {
      cfg.update({ autopilot: { apiUrl: 'https://relay.example/v1', apiKey: 'relay-key' } });
      expect(cfg.autopilotRelay()).toEqual({ baseUrl: 'https://relay.example/v1', apiKey: 'relay-key' });
    });
    it('is null when neither a provider nor a legacy key is set', () => {
      expect(cfg.autopilotRelay()).toBeNull();
    });
    it('reuses the referenced brain provider endpoint+key when providerId is set (legacy key ignored)', () => {
      cfg.update({ brain: { providers: [{ id: 'p1', label: 'P1', type: 'openai', baseUrl: 'https://p1.example/v1', models: ['m'], apiKey: 'p1-key' }] } });
      cfg.update({ autopilot: { providerId: 'p1', apiKey: 'legacy-should-be-ignored' } });
      expect(cfg.autopilotRelay()).toEqual({ baseUrl: 'https://p1.example/v1', apiKey: 'p1-key' });
    });
    it('is null when providerId points at a missing or keyless provider', () => {
      cfg.update({ autopilot: { providerId: 'ghost', apiKey: 'legacy' } });
      expect(cfg.autopilotRelay()).toBeNull();
    });
  });
  it('exposes only the VAPID public key, never the private one', () => {
    expect(cfg.get().webPush).toEqual({ publicKey: '', publicKeySet: false });
    expect(cfg.webPushKeys()).toBeNull();

    cfg.setWebPushKeys({ publicKey: 'pub-key', privateKey: 'priv-key' });
    const c = cfg.get();
    expect(c.webPush).toEqual({ publicKey: 'pub-key', publicKeySet: true });
    expect(JSON.stringify(c)).not.toContain('priv-key');
    expect(cfg.webPushKeys()).toEqual({ publicKey: 'pub-key', privateKey: 'priv-key' });
  });
  it('keeps the VAPID keypair across an unrelated config update', () => {
    cfg.setWebPushKeys({ publicKey: 'pub', privateKey: 'priv' });
    cfg.update({ autopilot: { model: 'x' } });
    expect(cfg.webPushKeys()).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  });
  it('defaults include empty autopilot notes and launch defaults', () => {
    const c = cfg.get();
    expect(c.autopilot.notes).toBe('');
    expect(c.defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 1 });
  });
  it('update merges notes and defaults', () => {
    cfg.update({ autopilot: { notes: 'be careful' }, defaults: { exec: 'codex:gpt-5.4', maxSessions: 3 } });
    const c = cfg.get();
    expect(c.autopilot.notes).toBe('be careful');
    expect(c.defaults).toEqual({ exec: 'codex:gpt-5.4', autonomy: 'L3', maxSessions: 3 });
  });
  it('seeds modelNotes from the built-in defaults and lets user edits win', () => {
    const seeded = cfg.get().modelNotes;
    expect(seeded.sonnet).toBeTruthy(); // built-in description present out of the box
    expect(seeded.opus).toBeTruthy();
    cfg.update({ modelNotes: { sonnet: 'Best for coding', 'my/custom': 'Cheap planner' } });
    const after = cfg.get().modelNotes;
    expect(after.sonnet).toBe('Best for coding'); // user edit overrides the seed
    expect(after['my/custom']).toBe('Cheap planner');
    expect(after.opus).toBe(seeded.opus); // untouched defaults stay backfilled
  });
  it('backfills built-in notes for a legacy row without modelNotes', () => {
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ allowedExecs: ['sonnet'] }));
    const notes = cfg.get().modelNotes;
    expect(notes.sonnet).toBeTruthy();
    expect(notes.opus).toBeTruthy();
  });
  it('defaults security.tokenTtlDays to 30 and updates it', () => {
    expect(cfg.get().security).toEqual({ tokenTtlDays: 30 });
    cfg.update({ security: { tokenTtlDays: 7 } });
    expect(cfg.get().security.tokenTtlDays).toBe(7);
  });
  it('clamps an invalid tokenTtlDays to the current value (floors fractionals, rejects < 1)', () => {
    cfg.update({ security: { tokenTtlDays: 14 } });
    cfg.update({ security: { tokenTtlDays: 0 } });       // invalid → keep 14
    expect(cfg.get().security.tokenTtlDays).toBe(14);
    cfg.update({ security: { tokenTtlDays: 9.8 } });     // floored
    expect(cfg.get().security.tokenTtlDays).toBe(9);
  });
  it('defaults sessionRetention to off with a 90-day horizon, toggles, and clamps days', () => {
    expect(cfg.get().sessionRetention).toEqual({ enabled: false, days: 90 });
    cfg.update({ sessionRetention: { enabled: true, days: 30 } });
    expect(cfg.get().sessionRetention).toEqual({ enabled: true, days: 30 });
    // An unrelated patch must not silently flip retention off or reset the horizon.
    cfg.update({ autoUpdate: true });
    expect(cfg.get().sessionRetention).toEqual({ enabled: true, days: 30 });
    // days feeds a SQL date modifier → same positive-integer clamp as tokenTtlDays.
    cfg.update({ sessionRetention: { days: 0 } });   // invalid → keep 30
    expect(cfg.get().sessionRetention.days).toBe(30);
    cfg.update({ sessionRetention: { days: 45.9 } }); // floored
    expect(cfg.get().sessionRetention.days).toBe(45);
  });
  it('defaults autoUpdate to off (opt-in) and toggles it', () => {
    expect(cfg.get().autoUpdate).toBe(false);
    cfg.update({ autoUpdate: true });
    expect(cfg.get().autoUpdate).toBe(true);
    cfg.update({ autoUpdate: false });
    expect(cfg.get().autoUpdate).toBe(false);
  });
  it('preserves autoUpdate across an unrelated patch and reads a legacy row as off', () => {
    cfg.update({ autoUpdate: true });
    cfg.update({ security: { tokenTtlDays: 5 } });       // unrelated patch keeps autoUpdate on
    expect(cfg.get().autoUpdate).toBe(true);
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(JSON.stringify({ allowedExecs: ['sonnet'] }));  // legacy row lacks autoUpdate
    expect(cfg.get().autoUpdate).toBe(false);
  });
  it('reads an old row without the new fields as defaults', () => {
    // write a raw pre-L2-8 row that lacks notes and defaults fields
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)").run(JSON.stringify({ allowedExecs: ['sonnet'], autopilot: { model: 'm', apiUrl: 'u' }, apiKey: null }));
    const c = cfg.get();
    expect(c.autopilot.notes).toBe('');
    expect(c.defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 1 });
  });
  it('reads an old row without customModels as empty array', () => {
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)").run(JSON.stringify({ allowedExecs: ['sonnet'], autopilot: { model: 'm', apiUrl: 'u' }, apiKey: null }));
    const c = cfg.get();
    expect(c.customModels).toEqual([]);
  });
  it('update replaces customModels when provided', () => {
    const custom = [{ label: 'My Model', exec: 'my/model' }];
    const c = cfg.update({ customModels: custom });
    expect(c.customModels).toEqual(custom);
  });
  it('update without customModels keeps existing customModels', () => {
    cfg.update({ customModels: [{ label: 'A', exec: 'a/model' }] });
    cfg.update({ allowedExecs: ['sonnet'] });
    expect(cfg.get().customModels).toEqual([{ label: 'A', exec: 'a/model' }]);
  });
  it('falls back to defaults when a stored row has the wrong shape (array fields as non-arrays)', () => {
    // Hand-edited / legacy row: allowedExecs as a string, customModels as an object.
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)")
      .run(JSON.stringify({ allowedExecs: 'sonnet', customModels: {}, hiddenPresets: 'x', apiKey: 42 }));
    const c = cfg.get();
    expect(Array.isArray(c.allowedExecs)).toBe(true);
    expect(c.allowedExecs).toContain('sonnet'); // defaulted, not the raw string
    expect(c.customModels).toEqual([]);
    expect(c.hiddenPresets).toEqual([]);
    expect(c.autopilot.apiKeySet).toBe(false); // numeric apiKey rejected → no key
  });
  it('drops malformed provider entries on read and update', () => {
    // Persist a row with a bad provider value (bin as a number).
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)")
      .run(JSON.stringify({ providers: { 'claude-code': { bin: 'claude', args: '' }, bad: { bin: 42, args: '' } } }));
    expect(cfg.get().providers.bad).toBeUndefined();
    // skipPermissions and resume default to true when an older row omits them.
    expect(cfg.get().providers['claude-code']).toEqual({ bin: 'claude', args: '', skipPermissions: true, resume: true });
    // A malformed provider in an update patch is also dropped.
    const c = cfg.update({ providers: { worse: { bin: 1, args: 2 } as unknown as { bin: string; args: string } } });
    expect(c.providers.worse).toBeUndefined();
  });
  it('ships default provider entries for the new agent CLIs (kilo/pi/omp)', () => {
    const p = cfg.get().providers;
    expect(p['kilo']).toEqual({ bin: 'kilo', args: '', skipPermissions: true, resume: true });
    expect(p['pi']).toEqual({ bin: 'pi', args: '', skipPermissions: true, resume: true });
    expect(p['omp']).toEqual({ bin: 'omp', args: '', skipPermissions: true, resume: true });
  });
  it('accepts a well-formed new-CLI exec for pilot/overseer (prefix passes the allow-list guard)', () => {
    const c = cfg.update({ autopilot: { pilotExec: 'kilo:anthropic/claude-sonnet-4-5', overseerExec: 'pi:sonnet' } });
    expect(c.autopilot.pilotExec).toBe('kilo:anthropic/claude-sonnet-4-5');
    expect(c.autopilot.overseerExec).toBe('pi:sonnet');
  });
  it('round-trips the per-provider skipPermissions toggle and defaults it on', () => {
    // Default providers carry skipPermissions: true out of the box.
    expect(cfg.get().providers['claude-code']?.skipPermissions).toBe(true);
    // An explicit false is persisted and returned; a fresh true flips it back.
    const off = cfg.update({ providers: { 'opencode': { bin: 'opencode', args: '', skipPermissions: false } } });
    expect(off.providers['opencode']).toEqual({ bin: 'opencode', args: '', skipPermissions: false, resume: true });
    const on = cfg.update({ providers: { 'opencode': { bin: 'opencode', args: '', skipPermissions: true } } });
    expect(on.providers['opencode']?.skipPermissions).toBe(true);
  });
  it('round-trips the per-provider resume toggle and defaults it on', () => {
    // Default providers carry resume: true out of the box.
    expect(cfg.get().providers['claude-code']?.resume).toBe(true);
    // An explicit false is persisted; resume stays off until flipped back.
    const off = cfg.update({ providers: { 'codex': { bin: 'codex', args: '', skipPermissions: true, resume: false } } });
    expect(off.providers['codex']).toEqual({ bin: 'codex', args: '', skipPermissions: true, resume: false });
    const on = cfg.update({ providers: { 'codex': { bin: 'codex', args: '', skipPermissions: true, resume: true } } });
    expect(on.providers['codex']?.resume).toBe(true);
  });
});

describe('ConfigStore pilot/overseer exec', () => {
  it('defaults both exec fields to empty string', () => {
    const c = new ConfigStore(openDb(':memory:'));
    expect(c.get().autopilot.pilotExec).toBe('');
    expect(c.get().autopilot.overseerExec).toBe('');
  });
  it('persists pilotExec and overseerExec independently', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ autopilot: { pilotExec: 'claude:opus' } });
    expect(c.get().autopilot.pilotExec).toBe('claude:opus');
    expect(c.get().autopilot.overseerExec).toBe('');
    c.update({ autopilot: { overseerExec: 'opencode:deepseek/deepseek-v4-flash' } });
    expect(c.get().autopilot.pilotExec).toBe('claude:opus'); // untouched
    expect(c.get().autopilot.overseerExec).toBe('opencode:deepseek/deepseek-v4-flash');
  });
  it('defaults reviewOnDone to false and persists true', () => {
    const c = new ConfigStore(openDb(':memory:'));
    expect(c.get().autopilot.reviewOnDone).toBe(false);
    c.update({ autopilot: { reviewOnDone: true } });
    expect(c.get().autopilot.reviewOnDone).toBe(true);
  });
});

describe('ConfigStore PR-native config', () => {
  it('defaults the four PR fields and ghTokenSet to off', () => {
    const c = new ConfigStore(openDb(':memory:'));
    const a = c.get().autopilot;
    expect(a.prEnabled).toBe(false);
    expect(a.prBaseBranch).toBe('');
    expect(a.prAutoOpen).toBe(false);
    expect(a.prVerifyCommand).toBe('');
    expect(a.ghTokenSet).toBe(false);
  });
  it('persists the PR fields and never returns the raw ghToken', () => {
    const c = new ConfigStore(openDb(':memory:'));
    const got = c.update({ autopilot: { prEnabled: true, prBaseBranch: 'develop', prAutoOpen: true, prVerifyCommand: 'npm test', ghToken: 'ghp_secret123' } });
    expect(got.autopilot.prEnabled).toBe(true);
    expect(got.autopilot.prBaseBranch).toBe('develop');
    expect(got.autopilot.prAutoOpen).toBe(true);
    expect(got.autopilot.prVerifyCommand).toBe('npm test');
    expect(got.autopilot.ghTokenSet).toBe(true);
    expect(JSON.stringify(got)).not.toContain('ghp_secret123');
    expect(c.ghToken()).toBe('ghp_secret123');
  });
  it('update without ghToken keeps the existing token', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ autopilot: { ghToken: 'ghp_keepme' } });
    c.update({ autopilot: { prEnabled: true } });
    expect(c.ghToken()).toBe('ghp_keepme');
    expect(c.get().autopilot.ghTokenSet).toBe(true);
  });
  it('reads a legacy row without PR fields as defaults', () => {
    const db2 = openDb(':memory:');
    db2.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ allowedExecs: ['sonnet'], autopilot: { model: 'm', apiUrl: 'u' }, apiKey: null }));
    const a = new ConfigStore(db2).get().autopilot;
    expect(a.prEnabled).toBe(false);
    expect(a.prBaseBranch).toBe('');
    expect(a.prAutoOpen).toBe(false);
    expect(a.prVerifyCommand).toBe('');
    expect(a.ghTokenSet).toBe(false);
  });
});

describe('ConfigStore exec validation (O22)', () => {
  it('rejects a bare bogus overseerExec/pilotExec, normalizing to empty', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ autopilot: { overseerExec: 'foo', pilotExec: 'bar' } });
    expect(c.get().autopilot.overseerExec).toBe(''); // bogus → unset, never reaches resolveExecutor
    expect(c.get().autopilot.pilotExec).toBe('');
  });
  it('accepts an allow-listed bare exec', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ autopilot: { overseerExec: 'sonnet' } }); // in default allowedExecs
    expect(c.get().autopilot.overseerExec).toBe('sonnet');
  });
  it('accepts a well-formed prefixed/slash exec not on the allow-list', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ autopilot: { pilotExec: 'claude:opus', overseerExec: 'opencode:deepseek/deepseek-v4-flash' } });
    expect(c.get().autopilot.pilotExec).toBe('claude:opus');
    expect(c.get().autopilot.overseerExec).toBe('opencode:deepseek/deepseek-v4-flash');
  });
  it('validates against the allowedExecs supplied in the same patch', () => {
    const c = new ConfigStore(openDb(':memory:'));
    // 'newbare' is bare + not well-formed; even allow-listing it in the same patch makes it valid.
    c.update({ allowedExecs: ['newbare'], autopilot: { overseerExec: 'newbare' } });
    expect(c.get().autopilot.overseerExec).toBe('newbare');
  });
  it('rejects an invalid defaults.exec, keeping the current value', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ defaults: { exec: 'codex:gpt-5.4' } });
    c.update({ defaults: { exec: 'bogus' } }); // bare, not allow-listed → keep previous
    expect(c.get().defaults.exec).toBe('codex:gpt-5.4');
  });
});
