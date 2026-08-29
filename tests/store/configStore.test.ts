import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

let db: Db;
let cfg: ConfigStore;
beforeEach(() => { db = openDb(':memory:'); cfg = new ConfigStore(db); });

describe('ConfigStore', () => {
  it('returns core defaults when empty', () => {
    const c = cfg.get();
    expect(c.allowedExecs).toContain('sonnet');
    expect(c.allowedExecs.length).toBe(11);
    expect(c.customModels).toEqual([]);
  });
  it('update replaces allowedExecs', () => {
    expect(cfg.update({ allowedExecs: ['sonnet'] }).allowedExecs).toEqual(['sonnet']);
  });
  it('allowedSkins defaults empty, enforces the attribute grammar and keeps the operator order', () => {
    // Empty by default: an instance that has not enabled skin switching must look exactly as it did
    // before switching existed, so the switcher has nothing to offer and does not render.
    expect(cfg.get().allowedSkins).toEqual([]);

    // The daemon does NOT know which skins a given web build compiled — that registry is a build
    // artifact of web/ — so an unrecognized name is stored and filtered by the browser, which does know.
    expect(cfg.update({ allowedSkins: ['default', 'studio-oled', 'not-built-yet'] }).allowedSkins)
      .toEqual(['default', 'studio-oled', 'not-built-yet']);

    // What IS enforced is the single-segment grammar, because the value ends up in a DOM attribute.
    expect(cfg.update({ allowedSkins: ['../etc', 'a b', "x'y", '-lead', 'Studio-OLED', 7, 'ok'] as unknown as string[] }).allowedSkins)
      .toEqual(['studio-oled', 'ok']);

    // Order is the operator's — it is the order the switcher cycles through — and duplicates collapse.
    expect(cfg.update({ allowedSkins: ['studio-oled', 'default', 'studio-oled'] }).allowedSkins)
      .toEqual(['studio-oled', 'default']);

    // A patch touching a sibling field must not reset the list; an explicit empty one turns it off.
    cfg.update({ autoUpdate: true });
    expect(cfg.get().allowedSkins).toEqual(['studio-oled', 'default']);
    expect(cfg.update({ allowedSkins: [] }).allowedSkins).toEqual([]);
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
    cfg.update({ autoUpdate: true });
    expect(cfg.webPushKeys()).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  });
  it('defaults launch settings', () => {
    expect(cfg.get().defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 2 });
  });
  it('update merges launch defaults', () => {
    cfg.update({ defaults: { exec: 'codex:gpt-5.4', maxSessions: 3 } });
    expect(cfg.get().defaults).toEqual({ exec: 'codex:gpt-5.4', autonomy: 'L3', maxSessions: 3 });
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
    expect(cfg.get().security).toEqual({ tokenTtlDays: 30, trustProxy: true });
    cfg.update({ security: { tokenTtlDays: 7 } });
    expect(cfg.get().security.tokenTtlDays).toBe(7);
    expect(cfg.get().security.trustProxy).toBe(true); // a partial patch must not reset the sibling flag
  });
  it('toggles security.trustProxy and keeps it across an unrelated patch', () => {
    cfg.update({ security: { trustProxy: false } });
    expect(cfg.get().security.trustProxy).toBe(false);
    cfg.update({ autoUpdate: true });
    expect(cfg.get().security.trustProxy).toBe(false);
    cfg.update({ security: { trustProxy: true } });
    expect(cfg.get().security.trustProxy).toBe(true);
  });
  it('clamps an invalid tokenTtlDays to the current value (floors fractionals, rejects < 1)', () => {
    cfg.update({ security: { tokenTtlDays: 14 } });
    cfg.update({ security: { tokenTtlDays: 0 } });       // invalid → keep 14
    expect(cfg.get().security.tokenTtlDays).toBe(14);
    cfg.update({ security: { tokenTtlDays: 9.8 } });     // floored
    expect(cfg.get().security.tokenTtlDays).toBe(9);
  });
  it('defaults sessionRetention to on with a 10-day horizon, toggles, and clamps days', () => {
    expect(cfg.get().sessionRetention).toEqual({ enabled: true, days: 10 });
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
    expect(c.defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 2 });
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

describe('ConfigStore exec validation (O22)', () => {
  it('rejects an invalid defaults.exec, keeping the current value', () => {
    const c = new ConfigStore(openDb(':memory:'));
    c.update({ defaults: { exec: 'codex:gpt-5.4' } });
    c.update({ defaults: { exec: 'bogus' } }); // bare, not allow-listed → keep previous
    expect(c.get().defaults.exec).toBe('codex:gpt-5.4');
  });
});

// review-api-store-sol, finding 7: the API route now rejects a hostile PUT via Zod, but a row written
// by an older build (or hand-edited) can already hold a bad element — these sanitisers protect that
// read path too, and the same element-level checks run when a patch is applied through `update()`
// directly (an internal caller bypassing the API's Zod schema).
describe('ConfigStore element-level sanitisation on corrupt stored JSON (finding 7)', () => {
  it('drops a non-string modelNotes value on read, keeping the built-in seed and other valid entries', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)')
      .run(JSON.stringify({ modelNotes: { sonnet: 7, opus: 'great for review' } }));
    const cs = new ConfigStore(db);
    const notes = cs.get().modelNotes;
    expect(notes.opus).toBe('great for review'); // valid entry survives
    expect(notes.sonnet).not.toBe(7); // the number never reaches a consumer
    expect(typeof notes.sonnet).toBe('string'); // falls back to the built-in seed
    // The actual downstream crash this closes: every consumer that renders the notes into a prompt
    // block calls .trim() on each listed note, which throws on a number. (The planner's modelsBlock is
    // one such consumer and lives in the work plugin now — the sanitisation that saves it is here.)
    expect(() => ['sonnet', 'opus'].map((m) => `${m}: ${notes[m]!.trim()}`).join('\n')).not.toThrow();
  });

  it('drops non-string allowedExecs elements on read', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)')
      .run(JSON.stringify({ allowedExecs: ['sonnet', 42, null, 'opus'] }));
    expect(new ConfigStore(db).get().allowedExecs).toEqual(['sonnet', 'opus']);
  });

  it('drops malformed customModels entries on read', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      customModels: [{ label: 'Good', exec: 'good/model' }, { label: 'Bad', exec: 7 }, { label: '', exec: 'noname' }, 'junk'],
    }));
    expect(new ConfigStore(db).get().customModels).toEqual([{ label: 'Good', exec: 'good/model' }]);
  });

  it('drops non-string plugins.enabled/removed elements on read', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      plugins: { enabled: ['files', 5, 'terminal'], removed: [null, 'skills'], config: {} },
    }));
    const p = new ConfigStore(db).get().plugins;
    expect(p.enabled).toEqual(['files', 'terminal']);
    expect(p.removed).toEqual(['skills']);
  });


  it('scrubs retired agents/work config, migration markers and unowned GitHub tokens without copying them', () => {
    const db2 = openDb(':memory:');
    db2.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      ghToken: 'top-level-secret',
      autopilot: { prEnabled: true },
      agentsConfigMigrated: true,
      agentsPluginConfigMigrated2: true,
      unrelatedInstallationKey: { keep: true },
      plugins: {
        enabled: ['files', 'agents', 'work'], removed: ['agents'],
        config: { agents: { ghToken: 'plugin-secret' }, work: { legacy: true }, files: { maxBytes: 10 } },
      },
    }));
    const cs = new ConfigStore(db2);
    cs.migrateRetiredPluginConfig();
    const stored = (db2.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data;
    const parsed = JSON.parse(stored) as Record<string, any>;
    expect(stored).not.toContain('top-level-secret');
    expect(stored).not.toContain('plugin-secret');
    expect(parsed).not.toHaveProperty('ghToken');
    expect(parsed).not.toHaveProperty('autopilot');
    expect(parsed).not.toHaveProperty('agentsConfigMigrated');
    expect(parsed).not.toHaveProperty('agentsPluginConfigMigrated2');
    expect(parsed.unrelatedInstallationKey).toEqual({ keep: true });
    expect(parsed.plugins.enabled).toEqual(['files']);
    expect(parsed.plugins.removed).toEqual([]);
    expect(parsed.plugins.config).toEqual({ files: { maxBytes: 10 } });
  });

  it('drops non-string hiddenPresets elements on read', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ hiddenPresets: ['a', 3, 'b'] }));
    expect(new ConfigStore(db).get().hiddenPresets).toEqual(['a', 'b']);
  });

  it('also sanitises a hostile patch applied directly through update() (an internal caller, not the API route)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({
      modelNotes: { sonnet: 7 as unknown as string, opus: 'ok' },
      allowedExecs: ['sonnet', 99 as unknown as string],
      customModels: [{ label: 'Good', exec: 'g/m' }, { label: 7 as unknown as string, exec: 'bad' }],
      plugins: { enabled: ['files', 1 as unknown as string] },
    });
    const c = cs.get();
    expect(c.modelNotes.opus).toBe('ok');
    expect(typeof c.modelNotes.sonnet).toBe('string'); // number dropped, built-in seed backfilled
    expect(c.allowedExecs).toEqual(['sonnet']);
    expect(c.customModels).toEqual([{ label: 'Good', exec: 'g/m' }]);
    expect(c.plugins.enabled).toEqual(['files']);
  });
});

describe('ConfigStore lsp plugin migration', () => {
  /** A pre-extraction install: diagnostics deliberately turned OFF, no `lsp` plugin, no marker. */
  const OLD_ROW = (over: Record<string, unknown> = {}) => JSON.stringify({
    allowedExecs: ['sonnet'],
    lspEnabled: false,
    plugins: { enabled: ['files', 'agents'], removed: [], config: {} },
    ...over,
  });
  const storeWith = (row: string): { cs: ConfigStore; stored: () => Record<string, unknown> } => {
    const db2 = openDb(':memory:');
    db2.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(row);
    return {
      cs: new ConfigStore(db2),
      stored: () => JSON.parse((db2.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data) as Record<string, unknown>,
    };
  };

  it('enables the plugin and copies the toggle once, losslessly (old DB)', () => {
    const { cs, stored } = storeWith(OLD_ROW());
    cs.migrateLspPlugin();
    expect(cs.get().plugins.enabled).toContain('lsp');
    // The operator's OFF survives the extraction — an upgrade must not silently restart tsserver.
    expect(cs.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: false });
    // Lossless: the core field is COPIED, not moved, so a rollback to a build that reads it still works.
    expect(stored()['lspEnabled']).toBe(false);
    // Idempotent: a second run leaves a later toggle (or a disable) exactly where the admin put it.
    cs.update({ plugins: { enabled: ['files', 'agents'], config: { lsp: { diagnosticsEnabled: true } } } });
    cs.migrateLspPlugin();
    expect(cs.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: true });
    expect(cs.get().plugins.enabled).not.toContain('lsp'); // stays disabled — the marker is set
  });

  it('never overwrites a plugins.config.lsp value the admin already set', () => {
    const { cs } = storeWith(OLD_ROW({ plugins: { enabled: ['files'], removed: [], config: { lsp: { diagnosticsEnabled: true } } } }));
    cs.migrateLspPlugin();
    expect(cs.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: true }); // theirs wins over lspEnabled:false
  });

  it('leaves an already-enabled plugin list untouched (no duplicate entry)', () => {
    const { cs } = storeWith(OLD_ROW({ plugins: { enabled: ['files', 'lsp'], removed: [], config: {} } }));
    cs.migrateLspPlugin();
    expect(cs.get().plugins.enabled.filter((n) => n === 'lsp')).toEqual(['lsp']);
  });

  it('is a no-op on a fresh install (no settings row → the defaults already carry the marker)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.migrateLspPlugin();
    expect(cs.pluginConfig('lsp')).toEqual({}); // unset → the plugin's own default (on)
    // A fresh install does NOT get lsp: it ships from the plugin registry now, so it is not on disk
    // until someone asks for it. The migration must stay clear of that decision — it exists to carry
    // EXISTING installs across (the cases above), not to reinstate a default that was deliberately
    // dropped. Enabling it here would leave every new instance pointing at a plugin it does not have.
    expect(cs.get().plugins.enabled).not.toContain('lsp');
  });
});
