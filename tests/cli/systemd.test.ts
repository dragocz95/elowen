import { describe, expect, it } from 'vitest';
import * as systemd from '../../src/cli/systemd.js';

type RestartTarget = 'daemon' | 'web' | 'all';
type Systemctl = (...args: string[]) => Promise<{ code: number; stdout: string }>;
type RestartServices = (target: RestartTarget, run?: Systemctl) => Promise<{ code: number; stdout: string }>;

describe('cli/systemd.restartServices', () => {
  it.each([
    ['daemon', ['restart', '--no-block', 'elowen-daemon']],
    ['web', ['restart', '--no-block', 'elowen-web']],
    ['all', ['restart', '--no-block', 'elowen-daemon', 'elowen-web']],
  ] as const)('hands %s to PID 1 without waiting', async (target, expected) => {
    const restartServices = (systemd as unknown as { restartServices?: RestartServices }).restartServices;
    expect(typeof restartServices).toBe('function');
    if (!restartServices) return;
    const calls: string[][] = [];
    const run: Systemctl = async (...args) => { calls.push(args); return { code: 0, stdout: '' }; };

    await restartServices(target, run);

    expect(calls).toEqual([[...expected]]);
  });
});
