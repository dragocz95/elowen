import { describe, expect, it } from 'vitest';
// The installed root helper is standalone ESM and exposes pure seams for contract testing.
// @ts-expect-error the standalone deployment helper intentionally has no TypeScript declaration file
import {
  ENVIRONMENT_PACKAGES,
  applyRequest,
  helperRequestFields,
} from '../../scripts/elowen-site-gateway.mjs';

const deployment = { appHost: 'agent.example.com', daemonPort: 4400, hostnameBase: 'sites.agent.example.com' };
const environment = { SUDO_USER: 'azureuser', SUDO_UID: '1000', SUDO_GID: '1000' };

type Result = { ok: boolean; stdout?: string; stderr?: string };
type Call = { file: string; args: string[] };

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
  };
  const calls: Call[] = [];
  const readText = (path: string) => {
    if (path === '/etc/subuid') return state.subuid ? 'azureuser:100000:65536\n' : '';
    if (path === '/etc/subgid') return state.subgid ? 'azureuser:100000:65536\n' : '';
    return '';
  };
  const runner = (file: string, args: string[]): Result => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/getent' && args[0] === 'passwd') {
      return { ok: true, stdout: 'azureuser:x:1000:1000:Azure User:/home/azureuser:/bin/bash\n' };
    }
    if (file === '/usr/bin/dpkg-query') {
      return state.installed.has(args.at(-1) ?? '')
        ? { ok: true, stdout: 'install ok installed\n' }
        : { ok: false, stderr: 'not installed' };
    }
    if (file === '/usr/bin/getent' && args[0] === 'subuid') {
      return state.subuid ? { ok: true, stdout: 'azureuser:100000:65536\n' } : { ok: false };
    }
    if (file === '/usr/bin/getent' && args[0] === 'subgid') {
      return state.subgid ? { ok: true, stdout: 'azureuser:100000:65536\n' } : { ok: false };
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
  return { state, calls, runner, readText };
}

describe('published-sites environment support helper', () => {
  it('accepts only the exact fieldless environment operation requests', async () => {
    expect(helperRequestFields({ op: 'environments-status' })).toEqual(['op']);
    expect(() => helperRequestFields({ op: 'environments-status', command: 'id' })).toThrow(/extra fields/);
    expect(() => helperRequestFields({ op: 'environments-provision', packages: ['curl'] })).toThrow(/extra fields/);
    await expect(applyRequest({ op: 'environments-status', command: 'id' }, deployment)).rejects.toThrow(/extra fields/);
    await expect(applyRequest({ op: 'environment-support-status' }, deployment)).rejects.toThrow(/not supported/);
  });

  it('reports every fixed dependency separately without mutating the host', async () => {
    const fixture = runnerFixture();
    const response = await applyRequest({ op: 'environments-status' }, deployment, { runner: fixture.runner, readText: fixture.readText, env: environment });

    expect(response).toMatchObject({ ok: true, ready: true });
    expect(response.items.map((item: { id: string }) => item.id)).toEqual([
      'package:podman', 'package:crun', 'package:uidmap', 'package:dbus-user-session', 'package:passt',
      'package:slirp4netns', 'package:fuse-overlayfs', 'subuid', 'subgid', 'linger', 'user-bus',
      'cgroup:cpu', 'cgroup:memory', 'cgroup:pids', 'podman-rootless',
    ]);
    expect(fixture.calls.some(({ file }) => file === '/usr/bin/apt-get' || file === '/usr/sbin/usermod')).toBe(false);
  });

  it('provisions only missing allowlisted dependencies and converges idempotently', async () => {
    const fixture = runnerFixture({
      installed: installedPackages().difference(new Set(['passt', 'slirp4netns'])),
      subuid: false,
      subgid: false,
      linger: false,
    });

    const first = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, env: environment });
    expect(first).toMatchObject({ ok: true, ready: true });

    const install = fixture.calls.find(({ file, args }) => file === '/usr/bin/apt-get' && args[0] === 'install');
    expect(install?.args).toEqual(['install', '--yes', '--no-install-recommends', 'passt', 'slirp4netns']);
    expect(fixture.calls).toContainEqual({ file: '/usr/sbin/usermod', args: ['--add-subuids', '100000-165535', 'azureuser'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/sbin/usermod', args: ['--add-subgids', '100000-165535', 'azureuser'] });
    expect(fixture.calls).toContainEqual({ file: '/usr/bin/loginctl', args: ['enable-linger', 'azureuser'] });

    const isMutation = ({ file, args }: Call) => file === '/usr/bin/apt-get'
      || file === '/usr/sbin/usermod'
      || (file === '/usr/bin/loginctl' && args[0] === 'enable-linger');
    const mutationCount = fixture.calls.filter(isMutation).length;
    const second = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, env: environment });
    expect(second).toMatchObject({ ok: true, ready: true });
    expect(fixture.calls.filter(isMutation)).toHaveLength(mutationCount);
  });

  it('installs fuse-overlayfs only when rootless podman reports an overlay requirement', async () => {
    const fixture = runnerFixture({ podman: false, overlayFailure: true });
    const response = await applyRequest({ op: 'environments-provision' }, deployment, { runner: fixture.runner, readText: fixture.readText, env: environment });
    expect(response).toMatchObject({ ok: true, ready: true });
    const installs = fixture.calls.filter(({ file, args }) => file === '/usr/bin/apt-get' && args[0] === 'install');
    expect(installs).toEqual([
      { file: '/usr/bin/apt-get', args: ['install', '--yes', '--no-install-recommends', 'fuse-overlayfs'] },
    ]);
  });
});
