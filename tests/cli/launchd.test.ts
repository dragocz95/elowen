import { describe, it, expect } from 'vitest';
import { launchdRestart, launchdServicesActive, launchdStart, launchdStatusText, launchdStop } from '../../src/cli/launchd.js';

/** Recording stand-in for runCmd: scripted per-command results, defaulting to success. */
function fakeRun(script: (cmd: string, args: string[]) => { code: number; stdout: string } | undefined) {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<{ code: number; stdout: string }> => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return script(cmd, args) ?? { code: 0, stdout: '' };
  };
  return { run, calls };
}

const uid = typeof process.getuid === 'function' ? process.getuid() : 501;

describe('cli/launchd', () => {
  it('start boots each agent out first, then bootstraps its plist (idempotent re-run)', async () => {
    const { run, calls } = fakeRun(() => undefined);
    const r = await launchdStart(run, '/Users/filip');
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      `launchctl bootout gui/${uid}/io.elowen.daemon`,
      `launchctl bootstrap gui/${uid} /Users/filip/Library/LaunchAgents/io.elowen.daemon.plist`,
      `launchctl bootout gui/${uid}/io.elowen.web`,
      `launchctl bootstrap gui/${uid} /Users/filip/Library/LaunchAgents/io.elowen.web.plist`,
    ]);
  });

  it('start surfaces a bootstrap failure; a bootout failure (not loaded yet) is expected and ignored', async () => {
    const { run } = fakeRun((_c, args) => (args[0] === 'bootout' ? { code: 3, stdout: '' }
      : args[2]?.includes('io.elowen.web') ? { code: 5, stdout: '' } : undefined));
    expect((await launchdStart(run, '/u')).code).toBe(5);
  });

  it('stop boots both agents out — KeepAlive would resurrect a plain kill', async () => {
    const { run, calls } = fakeRun(() => undefined);
    expect((await launchdStop(run)).code).toBe(0);
    expect(calls).toEqual([
      `launchctl bootout gui/${uid}/io.elowen.daemon`,
      `launchctl bootout gui/${uid}/io.elowen.web`,
    ]);
  });

  it('restart kickstarts a loaded agent and falls back to bootstrap for an unloaded one', async () => {
    const { run, calls } = fakeRun((_c, args) =>
      (args[0] === 'kickstart' && args[2]?.endsWith('io.elowen.web') ? { code: 113, stdout: '' } : undefined));
    expect((await launchdRestart(run, '/Users/filip')).code).toBe(0);
    expect(calls).toContain(`launchctl kickstart -k gui/${uid}/io.elowen.daemon`);
    expect(calls).toContain(`launchctl bootstrap gui/${uid} /Users/filip/Library/LaunchAgents/io.elowen.web.plist`);
  });

  it('reports active only when every agent prints state = running', async () => {
    const running = fakeRun(() => ({ code: 0, stdout: 'stuff\n\tstate = running\n\tpid = 42\n' }));
    expect(await launchdServicesActive(running.run)).toBe(true);
    const half = fakeRun((_c, args) => (args[1]?.endsWith('io.elowen.web') ? { code: 0, stdout: 'state = waiting' } : { code: 0, stdout: 'state = running' }));
    expect(await launchdServicesActive(half.run)).toBe(false);
    const unloaded = fakeRun(() => ({ code: 113, stdout: '' }));
    expect(await launchdServicesActive(unloaded.run)).toBe(false);
  });

  it('status text condenses launchctl print to the state/pid lines per agent', async () => {
    const { run } = fakeRun((_c, args) => (args[1]?.endsWith('io.elowen.web')
      ? { code: 113, stdout: '' }
      : { code: 0, stdout: 'a\n\tstate = running\n\tpid = 42\nb\n' }));
    const text = await launchdStatusText(run);
    expect(text).toContain('io.elowen.daemon: state = running · pid = 42');
    expect(text).toContain('io.elowen.web: not loaded');
  });
});
