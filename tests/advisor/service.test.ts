import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { AdvisorService } from '../../src/advisor/service.js';

function makeAdvisor(opts: { allowed: string[] }) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const u = users.create('amy', 'pw'); // first user → admin (fine; exec gate still bounded by config)
  const config = new ConfigStore(db);
  config.update({ allowedExecs: opts.allowed });
  const tmux = new FakeTmuxDriver();
  const spawnCalls: { agentName: string; extraEnv?: Record<string, string>; rawPrompt?: string }[] = [];
  const spawn = {
    launch: async (input: { agentName: string; projectPath: string; extraEnv?: Record<string, string>; rawPrompt?: string }) => {
      spawnCalls.push({ agentName: input.agentName, extraEnv: input.extraEnv, rawPrompt: input.rawPrompt });
      await tmux.spawn(`orca-${input.agentName}`, { cwd: input.projectPath, command: '' });
      return { session: `orca-${input.agentName}` };
    },
  };
  const svc = new AdvisorService({
    spawn: spawn as never, tmux, users, config,
    fallback: { program: 'claude-code', model: 'sonnet' },
    url: 'http://localhost:4400',
    advisorDir: () => '/tmp/advisor',
  });
  return { svc, spawnCalls, users, u, tmux };
}

describe('AdvisorService', () => {
  it('start spawns orca-advisor-<id>, persists exec, is idempotent', async () => {
    const { svc, spawnCalls, users, u } = makeAdvisor({ allowed: ['sonnet'] });
    const r = await svc.start(u.id, 'sonnet');
    expect(r.session).toBe(`orca-advisor-${u.id}`);
    expect(users.get(u.id)?.advisor_exec).toBe('sonnet');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].agentName).toBe(`advisor-${u.id}`);
    expect(spawnCalls[0].extraEnv?.ORCA_TOKEN).toBeTruthy(); // full advisor token injected
    await svc.start(u.id, 'sonnet'); // already live
    expect(spawnCalls).toHaveLength(1); // not respawned
  });

  it('rejects an exec not in the allow-list', async () => {
    const { svc, u } = makeAdvisor({ allowed: ['sonnet'] });
    await expect(svc.start(u.id, 'opus')).rejects.toThrow(/not allowed/);
  });

  it('status reflects running state and remembered exec', async () => {
    const { svc, u } = makeAdvisor({ allowed: ['sonnet'] });
    expect(await svc.status(u.id)).toEqual({ running: false, exec: '', session: null });
    await svc.start(u.id, 'sonnet');
    expect(await svc.status(u.id)).toEqual({ running: true, exec: 'sonnet', session: `orca-advisor-${u.id}` });
  });

  it('stop kills the session but keeps the remembered exec', async () => {
    const { svc, u } = makeAdvisor({ allowed: ['sonnet'] });
    await svc.start(u.id, 'sonnet');
    await svc.stop(u.id);
    const s = await svc.status(u.id);
    expect(s.running).toBe(false);
    expect(s.exec).toBe('sonnet'); // remembered for next autostart
  });

  it('ensureOnLogin starts only when an exec is set and autostart is on', async () => {
    const { svc, spawnCalls, users, u } = makeAdvisor({ allowed: ['sonnet'] });
    await svc.ensureOnLogin(u.id);
    expect(spawnCalls).toHaveLength(0); // no remembered exec yet
    users.setAdvisorExec(u.id, 'sonnet');
    await svc.ensureOnLogin(u.id);
    expect(spawnCalls).toHaveLength(1);
    await svc.stop(u.id);
    users.setAdvisorAutostart(u.id, false);
    await svc.ensureOnLogin(u.id);
    expect(spawnCalls).toHaveLength(1); // autostart off → not restarted
  });
});
