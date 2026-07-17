import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

describe('ConfigStore plugins', () => {
  it('defaults to the safe fresh-install tool set', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().plugins.enabled).toEqual(['files', 'terminal', 'askuser', 'runtime-context', 'skills', 'subagent', 'elowen-docs']);
  });

  it('round-trips plugins.enabled in the public view', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ plugins: { enabled: ['skills'], config: { skills: { dir: '/s' } } } });
    expect(cs.get().plugins.enabled).toEqual(['skills']);
  });

  it('never exposes per-plugin config in the public view', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ plugins: { enabled: ['x'], config: { x: { token: 'secret' } } } });
    expect(JSON.stringify(cs.get())).not.toContain('secret');
  });

  it('pluginConfig returns the daemon-side slice, {} for unknown', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ plugins: { enabled: ['x'], config: { x: { token: 'secret' } } } });
    expect(cs.pluginConfig('x')).toEqual({ token: 'secret' });
    expect(cs.pluginConfig('missing')).toEqual({});
  });

  it('merges config so touching one plugin keeps another slice', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ plugins: { enabled: ['a'], config: { a: { k: 1 } } } });
    cs.update({ plugins: { enabled: ['a', 'b'], config: { b: { k: 2 } } } });
    expect(cs.pluginConfig('a')).toEqual({ k: 1 });
    expect(cs.pluginConfig('b')).toEqual({ k: 2 });
  });
});
