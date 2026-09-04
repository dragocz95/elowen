import { describe, expect, it } from 'vitest';
// The installed root helper is standalone ESM and exposes pure seams for contract testing.
import {
  ENVIRONMENT_DELEGATION_CONTENT,
  ENVIRONMENT_DELEGATION_DROP_IN,
  ENVIRONMENT_PACKAGES,
  applyRequest,
  commandOptionsFor,
  helperRequestFields,
  supportedEnvironmentOs,
} from '../../scripts/elowen-site-gateway.mjs';

const deployment = { appHost: 'agent.example.com', daemonPort: 4400, hostnameBase: 'sites.agent.example.com' };
const environment = { SUDO_USER: 'azureuser', SUDO_UID: '1000', SUDO_GID: '1000' };

type Result = { ok: boolean; stdout?: string; stderr?: string };
type Call = { file: string; args: string[] };
type WriteCall = { path: string; content: string; mode: number };

function installedPackages(extra: string[] = []): Set<string> {
  return new Set([...ENVIRONMENT_PACKAGES, ...extra]);
}

function runnerFixture(options: {
  installed?: Set<string>;
  subuid?: boolean;
  subgid?: boolean;
  linger?: boolean;
  bus?: boolean;
  delegated?: string[];
  podman?: boolean;
  overlayFailure?: boolean;
  osRelease?: string;
  delegationDropIn?: string;
  passwd?: string;
} = {}) {
  const state = {
    installed: options.installed ?? installedPackages(),
    subuid: options.subuid ?? true,
    subgid: options.subgid ?? true,
    linger: options.linger ?? true,
    bus: options.bus ?? true,
    delegated: options.delegated ?? ['cpu', 'memory', 'pids'],
    podman: options.podman ?? true,
    overlayFailure: options.overlayFailure ?? false,
    osRelease: options.osRelease ?? 'ID=ubuntu\n',
    delegationDropIn: options.delegationDropIn ?? '',
    passwd: options.passwd ?? 'azureuser:x:1000:1000:Azure User:/home/azureuser:/bin/bash\n',
  };
  const calls: Call[] = [];
  const writes: WriteCall[] = [];
  const readText = (path: string) => {
    if (path === '/etc/os-release') return state.osRelease;
    if (path === '/etc/subuid') return state.subuid ? 'azureuser:100000:65536\n' : '';
    if (path === '/etc/subgid') return state.subgid ? 'azureuser:100000:65536\n' : '';
    if (path === ENVIRONMENT_DELEGATION_DROP_IN) return state.delegationDropIn;
    return '';
  };
  const writeAtomic = (path: string, content: Buffer, mode: number) => {
    const value = content.toString('utf8');
    writes.push({ path, content: value, mode });
    if (path === ENVIRONMENT_DELEGATION_DROP_IN) state.delegationDropIn = value;
  };
  const runner = (file: string, args: string[]): Result => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent' && args[0] === 'passwd') {
      return { ok: true, stdout: state.passwd };
    }
    if (file === '/usr/bin/dpkg-query') {
      return state.installed.has(args.at(-1) ?? '')
        ? { ok: true, stdout: 'install ok installed\n' }
        : { ok: false, stderr: 'not installed' };
    }
    if (file === '/usr/bin/loginctl' && args[0] === 'show-user') {
      return { ok: true, stdout: state.linger ? 'yes\n' : 'no\n' };
    }
    if (file === '/usr/bin/loginctl' && args[0] === 'enable-linger') {
      state.linger = true;
      state.bus = true;
      return { ok: true };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'show') {
      return { ok: true, stdout: `yes\n${state.delegated.join(' ')}\n` };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'daemon-reload') return { ok: true };
    if (file === '/usr/sbin/usermod' && args[0] === '--add-subuids') {
      state.subuid = true;
      return { ok: true };
    }
    if (file === '/usr/sbin/usermod' && args[0] === '--add-subgids') {
      state.subgid = true;
      return { ok: true };
    }
    if (file === '/usr/bin/apt-get' && args[0] === 'update') return { ok: true };
    if (file === '/usr/bin/apt-get' && args[0] === 'install') {
      for (const name of args.slice(3)) state.installed.add(name);
      if (args.includes('fuse-overlayfs')) {
        state.podman = true;
        state.overlayFailure = false;
      }
      return { ok: true };
    }
    if (file === '/usr/sbin/runuser') {
      if (args.includes('/usr/bin/systemctl')) return state.bus ? { ok: true } : { ok: false, stderr: 'Failed to connect to bus' };
      if (args.includes('/usr/bin/podman')) {
        if (!state.podman) {
          return { ok: false, stderr: state.overlayFailure ? 'overlay is not supported, install fuse-overlayfs' : 'podman failed' };
        }
        return {
          ok: true,
          stdout: JSON.stringify({ host: { security: { rootless: true }, cgroupManager: 'systemd', cgroupVersion: 'v2' }, store: { graphDriverName: 'overlay' } }),
        };
      }
    }
    return { ok: false, stderr: `unexpected command: ${file} ${args.join(' ')}` };
  };
  return { state, calls, writes, runner, readText, writeAtomic };
}

describe('published-sites environment support helper', () => {
  it('accepts only the exact fieldless environment operation requests', async () => {
    expect(helperRequestFields({ op: 'environments-status' })).toEqual(['op']);
    expect(() => helperRequestFields({ op: 'environments-status', command: 'id' })).toThrow(/extra fields/);
    expect(() => helperRequestFields({ op: 'environments-provision', packages: ['curl'] })).toThrow(/extra fields/);
    await expect(applyRequest({ op: 'environments-status', command: 'id' }, deployment)).rejects.toThrow(/extra fields/);
    await expect(applyRequest({ op: 'environment-support-status' }, deployment)).rejects.toThrow(/not supported/);
  });

  it('runs helper commands with a minimal environment and disables apt service restarts', () => {
    const update = commandOptionsFor('/usr/bin/apt-get', ['update']);
    const install = commandOptionsFor('/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', 'podman']);
    const systemctl = commandOptionsFor('/usr/bin/systemctl', ['daemon-reload']);

    expect([update.env, install.env]).toEqual([
      { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' },
      { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' },
    ]);
    expect(systemctl.env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
  });

  it('runs service-user probes with an exact empty environment', async () => {
    const fixture = runnerFixture();
    await applyRequest({ op: 'environments-status' }, deployment, {
      runner: fixture.runner,
      readText: fixture.readText,
      env: { ...environment, ELOWEN_TOKEN: 'secret', GITHUB_TOKEN: 'secret', ELOWEN_LOG_LEVEL: 'debug' },
    });
    const cleanPrefix = [
      '-u', 'azureuser', '--', '/usr/bin/env', '-i',
      'HOME=/home/azureuser', 'USER=azureuser', 'LOGNAME=azureuser',
      'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'XDG_RUNTIME_DIR=/run/user/1000',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
    ];
    const calls = fixture.calls.filter(({ file }) => file === '/usr/sbin/runuser');
    expect(calls).toEqual([
      { file: '/usr/sbin/runuser', args: [...cleanPrefix, '/usr/bin/podman', 'info', '--format', 'json'] },
      { file: '/usr/sbin/runuser', args: [...cleanPrefix, '/usr/bin/systemctl', '--user', 'show-environment'] },
    ]);
    expect(calls.flatMap(({ args }) => args).join('\n')).not.toMatch(/ELOWEN_|GITHUB_|SUDO_/);
  });

  it('accepts only Debian and Ubuntu and refuses provisioning before apt elsewhere', async () => {
    expect(supportedEnvironmentOs('ID=debian\n')).toEqual({ ok: true, detail: 'Debian is supported' });
    expect(supportedEnvironmentOs('NAME="Ubuntu"\nID="ubuntu"\n')).toEqual({ ok: true, detail: 'Ubuntu is supported' });
    expect(supportedEnvironmentOs('ID=fedora\n')).toEqual({ ok: false, detail: 'only Debian and Ubuntu are supported' });
    expect(supportedEnvironmentOs('NAME Ubuntu\n')).toEqual({ ok: false, detail: 'operating system information is malformed' });

    for (const osRelease of ['ID=fedora\n', 'NAME Ubuntu\n']) {
      const fixture = runnerFixture({ osRelease, installed: new Set() });
      const status = await applyRequest({ op: 'environments-status' }, deployment, {
        runner: fixture.runner,
        readText: fixture.readText,
        env: environment,
      }) as { items: Array<{ id: string; ok: boolean }> };
      expect(status.items[0]).toMatchObject({ id: 'os:supported', ok: false });
      await expect(applyRequest({ op: 'environments-provision' }, deployment, {
        runner: fixture.runner,
        readText: fixture.readText,
        writeAtomic: fixture.writeAtomic,
        env: environment,
      })).rejects.toThrow(/supported|malformed/);
      expect(fixture.calls.some(({ file }) => file === '/usr/bin/apt-get')).toBe(false);
      expect(fixture.writes).toEqual([]);
    }
  });

  it('rejects malformed sudo identities and subordinate-id files', async () => {
    const fixture = runnerFixture({ subuid: false, subgid: false });
    for (const [field, message] of [['SUDO_UID', /user id is invalid/], ['SUDO_GID', /group id is invalid/]] as const) {
      for (const bad of ['1000oops', '-1', '01000', '4294967296', '']) {
        await expect(applyRequest({ op: 'environments-status' }, deployment, {
          runner: fixture.runner,
          readText: fixture.readText,
          env: { ...environment, [field]: bad },
        })).rejects.toThrow(message);
      }
    }
    await expect(applyRequest({ op: 'environments-status' }, deployment, {
      runner: fixture.runner,
      readText: fixture.readText,
      env: { ...environment, SUDO_UID: '1001' },
    })).rejects.toThrow(/does not match sudo/);
    for (const passwd of [
      'other:x:1000:1000:Other:/home/other:/bin/bash\n',
      'azureuser:x:1000oops:1000:Azure:/home/azureuser:/bin/bash\n',
      'azureuser:x:1000:1000:Azure:relative:/bin/bash\n',
      'azureuser:x:1000:1000:Azure:/home/azureuser:/bin/bash\nextra:x:1001:1001::/home/extra:/bin/bash\n',
    ]) {
      const malformed = runnerFixture({ passwd });
      await expect(applyRequest({ op: 'environments-status' }, deployment, {
        runner: malformed.runner,
        readText: malformed.readText,
        env: environment,
      })).rejects.toThrow(/record is invalid/);
    }
    await expect(applyRequest({ op: 'environments-status' }, deployment, {
      runner: fixture.runner,
      readText: (path: string) => path === '/etc/os-release' ? 'ID=ubuntu\n' : path === '/etc/subuid' ? 'broken:value\n' : '',
      env: environment,
    })).rejects.toThrow(/invalid subordinate id entry/);
  });

  it('reports every fixed dependency separately without mutating the host', async () => {
    const fixture = runnerFixture();
    const response = await applyRequest({ op: 'environments-status' }, deployment, {
      runner: fixture.runner,
      readText: fixture.readText,
      writeAtomic: fixture.writeAtomic,
      env: environment,
    }) as { ok: boolean; ready: boolean; items: Array<{ id: string }> };

    expect(response).toMatchObject({ ok: true, ready: true });
    expect(response.items.map((item: { id: string }) => item.id)).toEqual([
      'os:supported', 'package:podman', 'package:crun', 'package:uidmap', 'package:dbus-user-session', 'package:passt',
      'package:slirp4netns', 'package:fuse-overlayfs', 'subuid', 'subgid', 'linger', 'user-bus',
      'cgroup:cpu', 'cgroup:memory', 'cgroup:pids', 'podman-rootless',
    ]);
    expect(fixture.calls.some(({ file }) => file === '/usr/bin/apt-get' || file === '/usr/sbin/usermod')).toBe(false);
  });

  it('provisions only missing allowlisted dependencies and converges idempotently', async () => {
    const fixture = runnerFixture({
      installed: new Set([...installedPackages()].filter((name) => name !== 'passt' && name !== 'slirp4netns')),
      subuid: false,
      subgid: false,
      linger: false,
    });

    const first = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, writeAtomic: fixture.writeAtomic, env: environment });
    expect(first).toMatchObject({ ok: true, ready: true });

    const install = fixture.calls.find(({ file, args }) => file === '/usr/bin/apt-get' && args[0] === 'install');
    expect(install?.args).toEqual(['install', '--yes', '--no-install-recommends', 'passt', 'slirp4netns']);
    expect(fixture.calls).toContainEqual({ file: '/usr/sbin/usermod', args: ['--add-subuids', '100000-165535', 'azureuser'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/sbin/usermod', args: ['--add-subgids', '100000-165535', 'azureuser'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/loginctl', args: ['enable-linger', 'azureuser'] });
    expect(fixture.writes).toEqual([]);
    expect(fixture.calls).not.toContainEqual({ file: '/usr/bin/systemctl', args: ['daemon-reload'] });

    const isMutation = ({ file, args }: Call) => file === '/usr/bin/apt-get'
      || file === '/usr/sbin/usermod'
      || (file === '/usr/bin/loginctl' && args[0] === 'enable-linger');
    const mutationCount = fixture.calls.filter(isMutation).length;
    const second = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, writeAtomic: fixture.writeAtomic, env: environment });
    expect(second).toMatchObject({ ok: true, ready: true });
    expect(fixture.calls.filter(isMutation)).toHaveLength(mutationCount);
  });

  it('allocates a collision-free subordinate-id range', async () => {
    const fixture = runnerFixture({ subuid: false, subgid: false });
    const readText = (path: string) => {
      if (path === '/etc/subuid' || path === '/etc/subgid') return 'another:100000:65536\n';
      return fixture.readText(path);
    };
    await applyRequest({ op: 'environments-provision' }, deployment, {
      runner: fixture.runner,
      readText,
      writeAtomic: fixture.writeAtomic,
      env: environment,
    });
    expect(fixture.calls).toContainEqual({
      file: '/usr/sbin/usermod',
      args: ['--add-subuids', '165536-231071', 'azureuser'],
    });
    expect(fixture.calls).toContainEqual({
      file: '/usr/sbin/usermod',
      args: ['--add-subgids', '165536-231071', 'azureuser'],
    });
  });

  it('writes the fixed delegation drop-in once without restarting services', async () => {
    const fixture = runnerFixture({ delegated: [] });
    const options = {
      runner: fixture.runner,
      readText: fixture.readText,
      writeAtomic: fixture.writeAtomic,
      env: environment,
    };

    const first = await applyRequest({ op: 'environments-provision' }, deployment, options);
    expect(first).toMatchObject({
      ok: true,
      ready: false,
      detail: 'systemd delegation is configured; a reboot or user-manager restart is required',
    });
    expect(fixture.writes).toEqual([{
      path: ENVIRONMENT_DELEGATION_DROP_IN,
      content: ENVIRONMENT_DELEGATION_CONTENT,
      mode: 0o644,
    }]);
    expect(fixture.calls.filter(({ file, args }) => file === '/usr/bin/systemctl' && args[0] === 'daemon-reload')).toHaveLength(1);

    await applyRequest({ op: 'environments-provision' }, deployment, options);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.calls.filter(({ file, args }) => file === '/usr/bin/systemctl' && args[0] === 'daemon-reload')).toHaveLength(2);

    const commandText = fixture.calls.map(({ file, args }) => `${file} ${args.join(' ')}`).join('\n');
    expect(commandText).not.toMatch(/\b(restart|try-restart|reload-or-restart)\b/);
    expect(commandText).not.toMatch(/elowen|nginx|chrome/i);
  });

  it('installs fuse-overlayfs only when rootless podman reports an overlay requirement', async () => {
    const fixture = runnerFixture({ podman: false, overlayFailure: true });
    const response = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, writeAtomic: fixture.writeAtomic, env: environment });
    expect(response).toMatchObject({ ok: true, ready: true });
    const installs = fixture.calls.filter(({ file, args }) => file === '/usr/bin/apt-get' && args[0] === 'install');
    expect(installs).toEqual([
      { file: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', 'fuse-overlayfs'] },
    ]);
  });
});
