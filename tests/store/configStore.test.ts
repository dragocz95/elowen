import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

let db: Db;
let cfg: ConfigStore;
beforeEach(() => { db = openDb(':memory:'); cfg = new ConfigStore(db); });

describe('ConfigStore', () => {
  it('returns defaults when empty (all execs allowed, key unset)', () => {
    const c = cfg.get();
    expect(c.allowedExecs).toContain('sonnet');
    expect(c.allowedExecs.length).toBe(5);
    expect(c.autopilot.apiKeySet).toBe(false);
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
  it('reads an old row without the new fields as defaults', () => {
    // write a raw pre-L2-8 row that lacks notes and defaults fields
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)").run(JSON.stringify({ allowedExecs: ['sonnet'], autopilot: { model: 'm', apiUrl: 'u' }, apiKey: null }));
    const c = cfg.get();
    expect(c.autopilot.notes).toBe('');
    expect(c.defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 1 });
  });
});
