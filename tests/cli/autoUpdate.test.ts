import { describe, it, expect } from 'vitest';
import { autoUpdate } from '../../src/cli/autoUpdate.js';

const env = {} as NodeJS.ProcessEnv;
const ranUpdate = async () => ({ updated: true, from: '1.0.0', to: '1.1.0' });

describe('cli/autoUpdate.autoUpdate', () => {
  it('skips without updating when the opt-in is off', async () => {
    let installed = false;
    const out = await autoUpdate(env, {
      current: '1.0.0',
      gate: () => ({ enabled: false, busy: false }),
      runUpdate: async () => { installed = true; return { updated: true, from: '1.0.0', to: '1.1.0' }; },
    });
    expect(out).toEqual({ ran: false, reason: 'disabled' });
    expect(installed).toBe(false);
  });

  it('updates when enabled and idle', async () => {
    const out = await autoUpdate(env, {
      current: '1.0.0',
      gate: () => ({ enabled: true, busy: false }),
      runUpdate: ranUpdate,
    });
    expect(out).toEqual({ ran: true, result: { updated: true, from: '1.0.0', to: '1.1.0' } });
  });
});
