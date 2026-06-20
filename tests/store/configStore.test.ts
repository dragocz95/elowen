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
    expect(c.allowedExecs.length).toBe(5);
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
  it('update without apiKey keeps the existing key', () => {
    cfg.update({ autopilot: { apiKey: 'k1' } });
    cfg.update({ autopilot: { model: 'x' } });
    expect(cfg.apiKey()).toBe('k1');
    expect(cfg.get().autopilot.apiKeySet).toBe(true);
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
    expect(cfg.get().providers['claude-code']).toEqual({ bin: 'claude', args: '' });
    // A malformed provider in an update patch is also dropped.
    const c = cfg.update({ providers: { worse: { bin: 1, args: 2 } as unknown as { bin: string; args: string } } });
    expect(c.providers.worse).toBeUndefined();
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
