import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { agentsPluginConfig } from '../../../plugins/agents/src/config.js';
import type { PluginHostConfig } from '../../../src/plugins/api.js';

const hostWith = (autopilot: Partial<{ overseerModel: string; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string }>): PluginHostConfig => ({
  get: () => ({ autopilot: { overseerModel: '', prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '', ...autopilot } }) as never,
  autopilotRelay: () => null,
  ghToken: () => null,
});

describe('agentsPluginConfig resolution', () => {
  it('the plugin config slice wins over the autopilot fallback', () => {
    const c = agentsPluginConfig(
      { overseerModel: 'slice-model', prAutoOpen: true },
      hostWith({ overseerModel: 'ap-model', prBaseBranch: 'main' }),
    );
    expect(c.overseerModel).toBe('slice-model');
    expect(c.prAutoOpen).toBe(true);
    // Keys the slice does not carry fall back to the LIVE autopilot values.
    expect(c.prBaseBranch).toBe('main');
    expect(c.prVerifyCommand).toBe('');
  });

  it('fresh install (empty slice) → the autopilot defaults', () => {
    const c = agentsPluginConfig({}, hostWith({}));
    expect(c).toEqual({ overseerModel: '', prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '' });
  });

  it('a malformed slice degrades to the fallback instead of throwing', () => {
    const c = agentsPluginConfig({ prAutoOpen: 'yes' as never }, hostWith({ prAutoOpen: true }));
    expect(c.prAutoOpen).toBe(true);
  });

  it('old DB with autopilot values → migration → the plugin reads the same effective values', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      autopilot: { model: 'm', apiUrl: 'u', overseerModel: 'ov', prBaseBranch: 'main', prAutoOpen: true, prVerifyCommand: 'npm test' },
      plugins: { enabled: ['agents'], removed: [], config: {} },
      agentsConfigMigrated: true,
    }));
    const store = new ConfigStore(db);
    store.migrateAgentsPluginConfig();
    const c = agentsPluginConfig(store.pluginConfig('agents'), store as unknown as PluginHostConfig);
    expect(c).toEqual({ overseerModel: 'ov', prBaseBranch: 'main', prAutoOpen: true, prVerifyCommand: 'npm test' });
  });
});
