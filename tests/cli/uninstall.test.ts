import { describe, it, expect } from 'vitest';
import type { ExecResult, Runner } from '../../src/cli/install/runner.js';
import { runUninstall, type UninstallDeps } from '../../src/cli/uninstall.js';
import type { InstallArtifacts, InstallInfo } from '../../src/cli/installInfo.js';

// The uninstall logic is exercised through an injected fake Runner that records every command — nothing
// here ever runs a real systemctl/rm/userdel/npm. The record fixtures mirror installInfo.test.ts's shapes.

const BASE: Omit<InstallInfo, 'artifacts'> = {
  publicUrl: 'https://build.coresynth.io',
  mode: 'domain',
  serviceUser: 'elowen',
  daemonPort: 4400,
  webPort: 4500,
};

const ARTIFACTS: InstallArtifacts = {
  version: '0.27.79',
  installedAt: '2026-08-01T13:00:00.000Z',
  units: [
    { path: '/etc/systemd/system/elowen-daemon.service', enabled: true },
    { path: '/etc/systemd/system/elowen-web.service', enabled: true },
    { path: '/etc/systemd/system/elowen-update.service', enabled: false },
    { path: '/etc/systemd/system/elowen-update.timer', enabled: true },
  ],
  sudoers: true,
  proxy: { kind: 'nginx', vhostPath: '/etc/nginx/sites-available/elowen.conf', tls: true },
  serviceUserCreated: true,
  agentClis: ['claude'],
};

const manifest = (over: Partial<InstallArtifacts> = {}): InstallInfo => ({ ...BASE, artifacts: { ...ARTIFACTS, ...over } });

/** A record written before artifact tracking existed — the "don't know what was created" case. */
const OLD_RECORD: InstallInfo = { ...BASE };

interface Harness {
  deps: UninstallDeps;
  calls: { cmd: string; args: string[] }[];
  out: string[];
  err: string[];
  confirms: string[];
}

function harness(over: {
  manifest?: InstallInfo | null;
  exec?: (cmd: string, args: string[]) => ExecResult | Promise<ExecResult>;
  confirm?: (m: string) => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
  home?: string;
  installInfoPath?: string;
} = {}): Harness {
  const calls: { cmd: string; args: string[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const runner: Runner = {
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (over.exec) return await over.exec(cmd, args);
      if (cmd === 'id' && args[0] === '-u') return { code: 0, stdout: '501\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    which: async () => null,
    writeFile: async () => {},
  };
  const deps: UninstallDeps = {
    runner,
    confirm: async (m) => { confirms.push(m); return over.confirm ? await over.confirm(m) : true; },
    out: (m) => { out.push(m); },
    err: (m) => { err.push(m); },
    readInfo: () => (over.manifest === undefined ? manifest() : over.manifest),
    installInfoPath: over.installInfoPath ?? '/etc/elowen/install.json',
    platform: over.platform ?? 'linux',
    home: over.home ?? '/root',
  };
  return { deps, calls, out, err, confirms };
}

const flat = (h: Harness): string[] => h.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);

describe('cli/uninstall — dry-run', () => {
  it('prints the full plan and runs no command at all', async () => {
    const h = harness();
    const code = await runUninstall(['--dry-run'], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    const printed = h.out.join('\n');
    expect(printed).toContain('would  stop elowen-daemon.service');
    expect(printed).toContain('would  remove /etc/systemd/system/elowen-daemon.service');
    expect(printed).toContain('would  remove /etc/sudoers.d/elowen');
    expect(printed).toContain('would  remove /etc/nginx/sites-available/elowen.conf');
    expect(printed).toContain('would  remove service user \'elowen\'');
    expect(printed).toContain('would  remove /etc/elowen/install.json');
    expect(printed).toContain('keep  data');
  });

  it('dry-run skips the confirmation prompts entirely', async () => {
    const h = harness({ confirm: () => { throw new Error('must not prompt'); } });
    await runUninstall(['--dry-run', '--purge'], h.deps);
    expect(h.confirms).toEqual([]);
  });
});

describe('cli/uninstall — order of operations', () => {
  it('stops and disables every unit before deleting its file, reloads systemd, and removes the record last', async () => {
    const h = harness();
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    const f = flat(h);
    const idx = (s: string): number => f.indexOf(s);
    expect(idx('systemctl stop elowen-daemon.service')).toBeGreaterThanOrEqual(0);
    expect(idx('systemctl stop elowen-daemon.service')).toBeLessThan(idx('systemctl disable elowen-daemon.service'));
    expect(idx('systemctl disable elowen-daemon.service')).toBeLessThan(idx('rm -f /etc/systemd/system/elowen-daemon.service'));
    expect(idx('rm -f /etc/systemd/system/elowen-daemon.service')).toBeLessThan(idx('systemctl daemon-reload'));
    expect(idx('systemctl daemon-reload')).toBeLessThan(idx('rm -f /etc/sudoers.d/elowen'));
    // the update SERVICE is stopped too (a timer fire may be mid-run), but never disabled — only its timer
    // is enabled (the record says enabled:false)
    expect(idx('systemctl stop elowen-update.service')).toBeGreaterThanOrEqual(0);
    expect(f).not.toContain('systemctl disable elowen-update.service');
    // the install record is the very last mutation
    expect(f[f.length - 1]).toBe('rm -f /etc/elowen/install.json');
  });

  it('denies the wildcard gateway before removing its privileged helper', async () => {
    const h = harness({ manifest: manifest({ siteGatewayHelper: true }) });
    await runUninstall(['--yes'], h.deps);
    const f = flat(h);
    const deny = f.indexOf('/usr/local/libexec/elowen-site-gateway ');
    const remove = f.indexOf('rm -f /usr/local/libexec/elowen-site-gateway');
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(deny);
    expect(f).toContain('rm -f /etc/elowen/site-gateway.json');
    expect(h.out.join('\n')).toContain('deny tombstone for stale wildcard DNS');
  });

  it('keeps the helper and deployment record when the wildcard deny fails', async () => {
    const h = harness({
      manifest: manifest({ siteGatewayHelper: true }),
      exec: (cmd) => cmd === '/usr/local/libexec/elowen-site-gateway'
        ? { code: 1, stdout: '', stderr: 'No such file or directory' }
        : { code: 0, stdout: '', stderr: '' },
    });
    expect(await runUninstall(['--yes'], h.deps)).toBe(1);
    const f = flat(h);
    expect(f).not.toContain('rm -f /etc/elowen/site-gateway.json');
    expect(f).not.toContain('rm -f /usr/local/libexec/elowen-site-gateway');
  });

  it('removes the recorded vhost, its sites-enabled link, then reloads the proxy', async () => {
    const h = harness();
    await runUninstall(['--yes'], h.deps);
    const f = flat(h);
    expect(f).toContain('rm -f /etc/nginx/sites-available/elowen.conf');
    expect(f).toContain('rm -f /etc/nginx/sites-enabled/elowen.conf');
    expect(f.indexOf('systemctl reload nginx')).toBeGreaterThan(f.indexOf('rm -f /etc/nginx/sites-available/elowen.conf'));
  });
});

describe('cli/uninstall — what it refuses to touch', () => {
  it('never removes the service user when the install did not create it', async () => {
    for (const created of [false, null] as const) {
      const h = harness({ manifest: manifest({ serviceUserCreated: created }) });
      const code = await runUninstall(['--yes'], h.deps);
      expect(code).toBe(0);
      expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
    }
  });

  it('keeps the data directory without --purge, and removes it with --purge', async () => {
    const getent = (cmd: string, args: string[]): ExecResult =>
      cmd === 'getent' && args[0] === 'passwd' && args[1] === 'elowen'
        ? { code: 0, stdout: 'elowen:x:998:998::/var/lib/elowen:/bin/bash\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const kept = harness({ exec: getent });
    expect(await runUninstall(['--yes'], kept.deps)).toBe(0);
    expect(kept.calls.some((c) => c.cmd === 'rm' && c.args.includes('-rf'))).toBe(false);
    expect(kept.out.some((m) => m.includes('pass --purge'))).toBe(true);

    const purged = harness({ exec: getent });
    expect(await runUninstall(['--yes', '--purge'], purged.deps)).toBe(0);
    expect(flat(purged)).toContain('rm -rf /var/lib/elowen/.config/elowen');
  });

  it('keeps the sudoers drop-in when the record says it was not created', async () => {
    const h = harness({ manifest: manifest({ sudoers: false }) });
    await runUninstall(['--yes'], h.deps);
    expect(flat(h).some((s) => s.includes('sudoers'))).toBe(false);
  });

  it('keeps the reverse proxy when the record says no vhost was written', async () => {
    const h = harness({ manifest: manifest({ proxy: undefined }) });
    await runUninstall(['--yes'], h.deps);
    expect(flat(h).some((s) => s.includes('nginx'))).toBe(false);
  });

  it('never uninstalls agent CLIs without a record', async () => {
    const h = harness({ manifest: null });
    await runUninstall(['--yes'], h.deps);
    expect(h.calls.some((c) => c.cmd === 'npm')).toBe(false);
  });

  it('refuses a recorded unit path that is not a recognizable elowen unit', async () => {
    const h = harness({ manifest: manifest({ units: [{ path: '/etc/passwd', enabled: true }] }) });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(1);
    expect(h.calls.some((c) => c.cmd === 'rm' && c.args.includes('/etc/passwd'))).toBe(false);
    expect(h.err.some((m) => m.includes('refusing'))).toBe(true);
  });

  it('leaves TLS certificates alone (they are bound to the domain, not to elowen)', async () => {
    const h = harness();
    await runUninstall(['--yes'], h.deps);
    expect(h.calls.some((c) => c.cmd === 'certbot')).toBe(false);
    expect(h.out.some((m) => m.includes('certificates'))).toBe(true);
  });
});

describe('cli/uninstall — idempotence', () => {
  it('a second run on an already-uninstalled box succeeds (missing = goal met)', async () => {
    const gone = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'systemctl' && (args[0] === 'stop' || args[0] === 'disable')) {
        return { code: 4, stdout: '', stderr: `Unit ${args[1]} could not be found.` };
      }
      if (cmd === 'userdel') return { code: 6, stdout: '', stderr: "userdel: user 'elowen' does not exist" };
      return { code: 0, stdout: '', stderr: '' };
    };
    const h = harness({ exec: gone });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    expect(h.err.some((m) => m.includes('FAIL'))).toBe(false);
    expect(h.out.some((m) => m.includes('elowen removed'))).toBe(true);
  });
});

describe('cli/uninstall — missing manifest fallback', () => {
  it('with no record at all it removes only the known units and warns that it is estimating', async () => {
    const h = harness({ manifest: null });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    const f = flat(h);
    expect(f).toContain('systemctl stop elowen-daemon.service');
    expect(f).toContain('systemctl stop elowen-update.timer');
    expect(f).toContain('rm -f /etc/systemd/system/elowen-daemon.service');
    expect(f).toContain('rm -f /etc/systemd/system/elowen-update.timer');
    expect(f).toContain('systemctl daemon-reload');
    expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
    expect(f.some((s) => s.includes('sudoers'))).toBe(false);
    expect(f.some((s) => s.includes('nginx'))).toBe(false);
    expect(h.err.some((m) => /estimate|no install record/i.test(m))).toBe(true);
  });

  it('a pre-artifacts record also falls back, touches no user/sudoers/proxy, and still removes the record', async () => {
    const h = harness({ manifest: OLD_RECORD });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    const f = flat(h);
    expect(f).toContain('systemctl stop elowen-daemon.service');
    expect(f).toContain('rm -f /etc/elowen/install.json');
    expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
    expect(f.some((s) => s.includes('sudoers') || s.includes('nginx'))).toBe(false);
    expect(h.err.some((m) => /estimate|no install record/i.test(m))).toBe(true);
  });

  it('--purge in fallback mode still leaves the data directory (cannot attribute it)', async () => {
    const h = harness({ manifest: null });
    const code = await runUninstall(['--yes', '--purge'], h.deps);
    expect(code).toBe(0);
    expect(h.calls.some((c) => c.cmd === 'rm' && c.args.includes('-rf'))).toBe(false);
    expect(h.out.some((m) => m.includes('no artifact record'))).toBe(true);
  });
});

describe('cli/uninstall — confirmation', () => {
  it('aborts without touching anything when the confirmation is declined', async () => {
    const h = harness({ confirm: () => false });
    const code = await runUninstall([], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out.some((m) => m.includes('nothing was changed'))).toBe(true);
  });

  it('asks once without --yes, not at all with --yes, and --purge confirms separately even with --yes', async () => {
    const plain = harness();
    await runUninstall([], plain.deps);
    expect(plain.confirms).toHaveLength(1);

    const yes = harness();
    await runUninstall(['--yes'], yes.deps);
    expect(yes.confirms).toHaveLength(0);

    const yesPurge = harness();
    await runUninstall(['--yes', '--purge'], yesPurge.deps);
    expect(yesPurge.confirms).toHaveLength(1);
    expect(yesPurge.confirms[0]).toMatch(/--purge/i);

    const purge = harness();
    await runUninstall(['--purge'], purge.deps);
    expect(purge.confirms).toHaveLength(2);
  });

  it('a declined --purge confirmation aborts the whole run', async () => {
    const h = harness({
      confirm: (m) => !m.includes('--purge'), // first (plan) ok, purge confirmation declined
    });
    const code = await runUninstall([], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('cli/uninstall — partial failure', () => {
  it('continues after a failed step and reports the manual fix, exiting non-zero', async () => {
    const exec = (cmd: string, args: string[]): ExecResult => {
      if (cmd === 'rm' && args.includes('/etc/sudoers.d/elowen')) return { code: 1, stdout: '', stderr: 'Permission denied' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const h = harness({ exec });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(1);
    const f = flat(h);
    // later steps still ran
    expect(f).toContain('userdel elowen');
    expect(f).toContain('rm -f /etc/elowen/install.json');
    expect(h.err.some((m) => m.includes('FAIL'))).toBe(true);
    // the manual recipe for the failed step is spelled out
    expect(h.err.some((m) => m.includes('rm -f /etc/sudoers.d/elowen'))).toBe(true);
  });
});

describe('cli/uninstall — macOS', () => {
  const macDeps = {
    platform: 'darwin' as NodeJS.Platform,
    home: '/Users/filip',
    installInfoPath: '/Users/filip/.config/elowen/install.json',
  };

  it('boots out the agents, removes the plists, uninstalls agent CLIs and (with --purge) the data dir', async () => {
    const h = harness(macDeps);
    const code = await runUninstall(['--yes', '--purge'], h.deps);
    expect(code).toBe(0);
    const f = flat(h);
    expect(f).toContain('launchctl bootout gui/501/io.elowen.daemon');
    expect(f).toContain('launchctl bootout gui/501/io.elowen.web');
    expect(f).toContain('launchctl bootout gui/501/io.elowen.update');
    expect(f).toContain('rm -f /Users/filip/Library/LaunchAgents/io.elowen.daemon.plist');
    expect(f).toContain('rm -f /Users/filip/Library/LaunchAgents/io.elowen.update.plist');
    expect(f).toContain('npm uninstall -g @anthropic-ai/claude-code');
    expect(f).toContain('rm -rf /Users/filip/.config/elowen');
    expect(h.calls.some((c) => c.cmd === 'systemctl')).toBe(false);
    expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
    // bootout (stop) before the plist is removed; record removed last
    expect(f.indexOf('launchctl bootout gui/501/io.elowen.daemon')).toBeLessThan(f.indexOf('rm -f /Users/filip/Library/LaunchAgents/io.elowen.daemon.plist'));
    expect(f[f.length - 1]).toBe('rm -f /Users/filip/.config/elowen/install.json');
  });

  it('macOS without --purge keeps the data directory', async () => {
    const h = harness(macDeps);
    expect(await runUninstall(['--yes'], h.deps)).toBe(0);
    expect(h.calls.some((c) => c.cmd === 'rm' && c.args.includes('-rf'))).toBe(false);
  });

  it('macOS without a record still removes the known agents and tolerates a second run', async () => {
    const gone = (cmd: string, args: string[]): ExecResult =>
      cmd === 'id' && args[0] === '-u'
        ? { code: 0, stdout: '501\n', stderr: '' }
        : cmd === 'launchctl'
          ? { code: 3, stdout: '', stderr: `Could not find service "${args[1]}" in domain` }
          : { code: 0, stdout: '', stderr: '' };
    const h = harness({ ...macDeps, manifest: null, exec: gone });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    const f = flat(h);
    expect(f).toContain('launchctl bootout gui/501/io.elowen.daemon');
    expect(f).toContain('rm -f /Users/filip/Library/LaunchAgents/io.elowen.daemon.plist');
    expect(h.calls.some((c) => c.cmd === 'npm')).toBe(false);
    expect(h.err.some((m) => m.includes('FAIL'))).toBe(false);
  });
});

describe('cli/uninstall — a record that cannot be trusted', () => {
  it('falls back to the estimate path when artifacts is structurally wrong, instead of throwing', async () => {
    // The record is a file on disk: hand-edited, half-written by an interrupted install, or restored
    // from a backup of another version. Walking a shape that is not the shape threw mid-command.
    const broken = { ...BASE, artifacts: 'not-an-object' } as unknown as InstallInfo;
    const h = harness({ manifest: broken });
    const code = await runUninstall(['--yes'], h.deps);
    expect(code).toBe(0);
    expect(flat(h).some((c) => c.includes('stop elowen-daemon'))).toBe(true); // known units still torn down
    // Estimate mode must stay off everything whose origin it cannot prove.
    expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
    expect(flat(h).some((c) => c.includes('sudoers'))).toBe(false);
  });

  it('treats a units field of the wrong type the same way — no crash, no user deletion', async () => {
    const broken = { ...BASE, artifacts: { ...ARTIFACTS, units: 'elowen-daemon' } } as unknown as InstallInfo;
    const h = harness({ manifest: broken });
    expect(await runUninstall(['--yes'], h.deps)).toBe(0);
    expect(h.calls.some((c) => c.cmd === 'userdel')).toBe(false);
  });
});

describe('cli/uninstall — --purge tells the truth', () => {
  it('fails the step when the home cannot be resolved, instead of reporting a delete that did not happen', async () => {
    // --purge is the one irreversible thing the user opts into. Reporting "done" while the database is
    // still on disk makes the summary lie about exactly the step that mattered — so an unresolvable
    // home has to fail, with the manual command, not pass quietly.
    const info: InstallInfo = { ...BASE, artifacts: { ...ARTIFACTS, serviceUserCreated: false } };
    const h = harness({
      manifest: info,
      // getent finding no such user is how the home fails to resolve; everything else succeeds.
      exec: (cmd) => (cmd === 'getent' ? { code: 2, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    });
    const code = await runUninstall(['--yes', '--purge'], h.deps);
    expect(code).toBe(1);
    expect(h.err.some((m) => m.includes('FAIL'))).toBe(true);
    expect(h.calls.some((c) => c.cmd === 'rm' && c.args.join(' ').includes('.config/elowen'))).toBe(false);
  });
});

describe('cli/uninstall — usage', () => {
  it('rejects an unknown option with a usage error and touches nothing', async () => {
    const h = harness();
    const code = await runUninstall(['--puarge'], h.deps);
    expect(code).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.some((m) => m.includes('unknown option'))).toBe(true);
  });

  it('prints help for --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const h = harness();
      expect(await runUninstall([flag], h.deps)).toBe(0);
      expect(h.out.some((m) => m.includes('elowen uninstall'))).toBe(true);
      expect(h.calls).toEqual([]);
    }
  });
});
