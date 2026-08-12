import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { agentsPluginConfig } from '../../../plugins/agents/src/config.js';
import type { PluginHostConfig } from '../../../src/plugins/api.js';

const AUTOPILOT_DEFAULTS = {
  overseerModel: '', prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '',
  pilotExec: '', overseerExec: '', reviewOnDone: false, tddMode: false, prEnabled: false,
};

const hostWith = (autopilot: Partial<typeof AUTOPILOT_DEFAULTS>, ghToken: string | null = null): PluginHostConfig => ({
  get: () => ({ autopilot: { ...AUTOPILOT_DEFAULTS, ...autopilot } }) as never,
  autopilotRelay: () => null,
  ghToken: () => ghToken,
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
    expect(c).toEqual({ ...AUTOPILOT_DEFAULTS, ghToken: '' });
  });

  it('wave-2 keys resolve slice-first with the autopilot/ghToken fallback', () => {
    const c = agentsPluginConfig(
      { pilotExec: 'codex:gpt', tddMode: true },
      hostWith({ pilotExec: 'claude:opus', overseerExec: 'claude:sonnet', prEnabled: true }, 'legacy-token'),
    );
    expect(c.pilotExec).toBe('codex:gpt'); // slice wins
    expect(c.tddMode).toBe(true);
    expect(c.overseerExec).toBe('claude:sonnet'); // absent in slice → live autopilot value
    expect(c.prEnabled).toBe(true);
    expect(c.ghToken).toBe('legacy-token'); // absent/empty in slice → host ghToken()
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
    store.migrateAgentsPluginConfigWave2();
    const c = agentsPluginConfig(store.pluginConfig('agents'), store as unknown as PluginHostConfig);
    expect(c).toEqual({ ...AUTOPILOT_DEFAULTS, overseerModel: 'ov', prBaseBranch: 'main', prAutoOpen: true, prVerifyCommand: 'npm test', ghToken: '' });
  });
});
