import { describe, expect, it, vi } from 'vitest';
import { createNspawnRuntimeControl, nspawnHelperTimeoutMs } from '../../src/privileged/nspawnRuntime.js';

const MACHINE = 'elowen-project-54-g3';
const UNIT = `elowen-exec-g3-${'a'.repeat(32)}.service`;
const disk = {
  namespace: 'elowen',
  kind: 'project' as const,
  resource: '54',
  generation: 3,
  diskId: 'a'.repeat(32),
  machine: MACHINE,
  specHash: 'd'.repeat(64),
};
const TREE = `/srv/sandbox/projects/54/disks/${'a'.repeat(32)}/rootfs`;
const helperOk = {
  status: vi.fn(async () => ({ id: 'helper:site-gateway', label: 'Published-sites gateway helper', ok: true, detail: 'installed helper matches this Elowen release' })),
  install: vi.fn(async () => false),
};

describe('machine runtime control: request contract', () => {
  it('marks every request with the machine domain', async () => {
    const invoke = vi.fn(async () => ({ ok: true, digest: 'a'.repeat(64), logicalBytes: 1, allocatedBytes: 2, members: 3 }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });

    await control.freeze(MACHINE);
    await control.thaw(MACHINE);
    await control.treeFingerprint(TREE);
    await control.treeRemove(`${TREE}.pending`);
    await control.destroy({ machine: MACHINE, kind: 'project', resource: '54', diskId: disk.diskId });

    const requests = invoke.mock.calls.map(([request]) => request);
    expect(requests.every((request) => request.domain === 'nspawn')).toBe(true);
    expect(requests.map((request) => request.op)).toEqual(['freeze', 'thaw', 'tree-fingerprint', 'tree-remove', 'destroy']);
    // A tree operation names a path because the runtime derives shapes the helper cannot re-derive from
    // an id. The helper re-validates each of them against its own trusted roots.
    expect(requests[2]).toEqual({ domain: 'nspawn', op: 'tree-fingerprint', path: TREE });
    expect(requests[4]).not.toHaveProperty('path');
  });

  it('refuses a malformed machine name before reaching sudo', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });
    for (const bad of ['../../etc', 'elowen-project-54', 'other-project-1-g1']) {
      await expect(control.freeze(bad)).rejects.toThrow(/machine name is invalid/);
      await expect(control.exec({ machine: bad, unit: UNIT, argv: ['/bin/true'], cwd: '/workspace', timeoutSeconds: 10 })).rejects.toThrow(/machine name is invalid/);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('carries the guest stdin beside the request and decodes the separated output', async () => {
    const invoke = vi.fn(async () => ({
      ok: true, exitCode: 42, signal: null, timedOut: false, truncated: false,
      stdout: Buffer.from('out').toString('base64'), stderr: Buffer.from('err').toString('base64'),
    }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });
    const input = Buffer.alloc(1024 * 1024, 7);
    const result = await control.exec({ machine: MACHINE, unit: UNIT, argv: ['/bin/cat'], cwd: '/workspace', timeoutSeconds: 30 }, input);

    expect(result).toMatchObject({ exitCode: 42, timedOut: false, truncated: false });
    expect(result.stdout.toString()).toBe('out');
    expect(result.stderr.toString()).toBe('err');
    expect(invoke.mock.calls[0][0]).toEqual({
      domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/cat'], cwd: '/workspace', timeoutSeconds: 30,
    });
    // The megabyte of guest input is handed through untouched, not copied or re-encoded.
    expect(invoke.mock.calls[0][1]).toBe(input);
  });

  it('surfaces a refusal as an error rather than a success-shaped result', async () => {
    const control = createNspawnRuntimeControl({
      invoke: async () => ({ ok: false, detail: 'the machine name is invalid' }),
      helper: helperOk,
    });
    await expect(control.thaw(MACHINE)).rejects.toThrow(/machine name is invalid/);
  });

  it('rejects a fingerprint a root process reports in the wrong shape', async () => {
    const control = createNspawnRuntimeControl({
      invoke: async () => ({ ok: true, digest: 'not-a-digest', logicalBytes: 1, allocatedBytes: 2 }),
      helper: helperOk,
    });
    await expect(control.treeFingerprint(TREE)).rejects.toThrow(/invalid disk tree fingerprint/);
  });

  it('answers a free-space question and an archive verification without hashing anything', async () => {
    const invoke = vi.fn(async (request: { op: string }) => (request.op === 'tree-preflight'
      ? { ok: true, requiredBytes: 10, marginBytes: 67_108_864, freeBytes: 1 << 30 }
      : { ok: true, members: 812 }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });
    expect(await control.treePreflight([TREE], '/srv/sandbox/projects/54/snapshots')).toEqual({
      requiredBytes: 10, marginBytes: 67_108_864, freeBytes: 1 << 30,
    });
    expect(await control.treeVerify('/srv/sandbox/projects/54/migrations/m1/rootfs.tar', `${TREE}.pending`)).toEqual({ members: 812 });
    expect(invoke.mock.calls.map(([request]) => request.op)).toEqual(['tree-preflight', 'tree-verify']);
  });

  it('returns the receipt a rollback reverses the ownership pass with', async () => {
    const invoke = vi.fn(async () => ({ ok: true, uidBase: 1_073_741_824, uidSize: 65_536, previousUidBase: 100_000 }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });
    expect(await control.shiftOwnership({ ...disk, target: 'nspawn' }))
      .toEqual({ uidBase: 1_073_741_824, uidSize: 65_536, previousUidBase: 100_000 });
    await control.shiftOwnership({ ...disk, target: 'podman', uidBase: 100_000 });
    expect(invoke.mock.calls.map(([request]) => [request.target, request.uidBase])).toEqual([['nspawn', null], ['podman', 100_000]]);

    const control2 = createNspawnRuntimeControl({ invoke: async () => ({ ok: true }), helper: helperOk });
    await expect(control2.shiftOwnership({ ...disk, target: 'nspawn' })).rejects.toThrow(/invalid ownership shift receipt/);
  });

  it('gives execution its own budget and the long-running disk work fifteen minutes', () => {
    expect(nspawnHelperTimeoutMs({ domain: 'nspawn', op: 'status' })).toBe(30_000);
    expect(nspawnHelperTimeoutMs({ domain: 'nspawn', op: 'provision' })).toBe(12 * 60_000);
    expect(nspawnHelperTimeoutMs({ domain: 'nspawn', op: 'tree-copy', sourcePath: TREE, targetPath: `${TREE}.pending` })).toBe(15 * 60_000);
    expect(nspawnHelperTimeoutMs({ domain: 'nspawn', op: 'exec', machine: MACHINE, unit: UNIT, argv: ['/bin/true'], cwd: '/', timeoutSeconds: 120 })).toBe(135_000);
  });
});

describe('machine runtime control: readiness', () => {
  it('reports the helper digest first and never asks a drifted helper for anything', async () => {
    const invoke = vi.fn();
    const control = createNspawnRuntimeControl({
      invoke,
      helper: {
        status: vi.fn(async () => ({ id: 'helper:site-gateway', label: 'Published-sites gateway helper', ok: false, detail: 'Run: sudo -n /usr/bin/install …' })),
        install: vi.fn(async () => true),
      },
    });
    expect(await control.status()).toEqual({
      ready: false,
      items: [expect.objectContaining({ id: 'helper:site-gateway', ok: false })],
      detail: 'the installed privileged helper differs from this Elowen release',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reinstalls the helper on provisioning and reports every host artefact row', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      ready: true,
      items: [
        { id: 'package:systemd-container', label: 'systemd container tools', ok: true, detail: 'installed' },
        { id: 'polkit:machines', label: 'Machine lifecycle authorization', ok: true },
        { id: 'unit:elowen-machine', label: 'Machine unit template', ok: true },
        { id: 'bogus', ok: 'yes' },
      ],
    }));
    const helper = { status: helperOk.status, install: vi.fn(async () => true) };
    const audit = { info: vi.fn(), warn: vi.fn() };
    const control = createNspawnRuntimeControl({ invoke, helper, audit });

    const result = await control.provision({ veth: true });
    expect(helper.install).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({ domain: 'nspawn', op: 'provision', veth: true });
    // A malformed row from the helper is dropped rather than trusted into the UI.
    expect(result.items.map((item) => item.id)).toEqual([
      'helper:site-gateway', 'package:systemd-container', 'polkit:machines', 'unit:elowen-machine',
    ]);
    expect(result.ready).toBe(true);
    expect(audit.warn).not.toHaveBeenCalled();
  });

  it('omits the veth flag when veth is not requested', async () => {
    const invoke = vi.fn(async () => ({ ok: true, ready: true, items: [{ id: 'unit:elowen-machine', label: 'Machine unit template', ok: true }] }));
    const control = createNspawnRuntimeControl({ invoke, helper: helperOk });
    await control.status();
    expect(invoke).toHaveBeenCalledWith({ domain: 'nspawn', op: 'status' });
  });

  it('reports a helper failure as an unready checklist instead of throwing', async () => {
    const control = createNspawnRuntimeControl({
      invoke: async () => { throw new Error('the machine runtime helper is not installed'); },
      helper: helperOk,
    });
    expect(await control.status()).toEqual({ ready: false, items: [], detail: 'the machine runtime helper is not installed' });
  });
});
