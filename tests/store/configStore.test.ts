import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

let cfg: ConfigStore;
beforeEach(() => { cfg = new ConfigStore(openDb(':memory:')); });

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
});
