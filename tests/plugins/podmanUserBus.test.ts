import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ uid: 1000, parentUid: 1000, mode: 0o700, socket: true, symlink: false, ino: 42, dev: 1 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, lstatSync: (path: string, ...args: any[]) => {
    if (path === '/run/user/1000/bus') return { ...bus, isSocket: () => bus.socket, isSymbolicLink: () => bus.symlink };
    if (path === '/run/user' || path === '/run/user/1000') return { uid: path === '/run/user' ? 0 : bus.parentUid, mode: bus.mode, isDirectory: () => true, isSymbolicLink: () => false };
    return (fs.lstatSync as any)(path, ...args);
  } };
});
import { isolatedPodmanOptions, PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ep-bus-'));
  Object.assign(bus, { uid: 1000, parentUid: 1000, mode: 0o700, socket: true, symlink: false, ino: 42, dev: 1 });
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/untrusted/ambient-bus');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('binds only the validated existing user bus while keeping private storage and runtime paths', async () => {
  const options = isolatedPodmanOptions(join(root, 'p'), 'test-bus', { useUserSessionBus: true });
  const executor = { run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ host: { security: { rootless: true } } }), stderr: '' })) };
  await new PodmanClient({ ...options, executor }).info();
  const [, args, launch] = executor.run.mock.calls[0]! as any;
  expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
  expect(launch.env.XDG_RUNTIME_DIR).toBe(join(root, 'p/runtime'));
  expect(launch.env.HOME).toBe(join(root, 'p/home'));
  expect(args).toContain(join(root, 'p/storage'));
  expect(args).toContain(join(root, 'p/runroot'));
});

it.each(['owner', 'socket', 'symlink', 'directory'])('refuses an untrusted user bus %s', (field) => {
  if (field === 'owner') bus.uid = 1001;
  if (field === 'socket') bus.socket = false;
  if (field === 'symlink') bus.symlink = true;
  if (field === 'directory') bus.mode = 0o777;
  expect(() => isolatedPodmanOptions(join(root, 'p'), 'test-bus', { useUserSessionBus: true })).toThrow(/bus|session/i);
});

it('revalidates the pinned socket before every process launch', async () => {
  const options = isolatedPodmanOptions(join(root, 'p'), 'test-bus', { useUserSessionBus: true });
  const executor = { run: vi.fn() };
  const client = new PodmanClient({ ...options, executor });
  bus.ino++;
  await expect(client.info()).rejects.toThrow(/bus|session/i);
  expect(executor.run).not.toHaveBeenCalled();
});

it('never accepts arbitrary bus addresses through isolation options', () => {
  expect(() => isolatedPodmanOptions(join(root, 'p'), 'test-bus', { busPath: '/untrusted/bus' })).toThrow();
});
