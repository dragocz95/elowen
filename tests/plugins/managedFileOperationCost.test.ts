import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { PodmanClient } from '../../plugins/sandbox/lib/podman.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

/** What one managed file operation COSTS, measured in Podman subprocesses.
 *
 *  The audit measured a trivial guest file operation issuing about 33 Podman invocations, each one a
 *  process spawn of its own. At the 100-400 ms a rootless `podman` start-up actually took on the measured
 *  host, that fixed transport — not the file, not the model — is what made an empty directory listing
 *  cost seconds. Every invocation counted here is a real process, so the count IS the latency budget, and
 *  asserting it is how a change that reintroduces a redundant inspect or a second release gets caught by
 *  a test rather than by someone waiting on an editor.
 *
 *  Only the executor is faked. The real PodmanClient, ContainerStorage and environment runtime sit above
 *  it, so the ownership, generation, lease and cleanup invariants under test are the shipped ones. The
 *  fake models the container/volume store from the arguments it is given rather than replaying a fixed
 *  answer, so a spec the client never actually created cannot inspect successfully. */

const CONTAINER_ID = 'a'.repeat(64);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

interface Call { args: string[]; input?: string }

/** `--flag=value` / repeated `--label k=v` argv as a record, which is all the fake needs to answer an
 *  inspect with the shape the client demands. */
function parseCreate(args: string[]) {
  const labels: Record<string, string> = {};
  const mounts: { type: string; source: string; target: string; readOnly: boolean }[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--label') { const [key, ...rest] = args[++index]!.split('='); labels[key!] = rest.join('='); continue; }
    if (arg === '--mount') {
      const parts = Object.fromEntries(args[++index]!.split(',').map((part) => part.split('=') as [string, string]));
      mounts.push({ type: parts.type!, source: parts.src!, target: parts.dst!, readOnly: 'ro' in parts });
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) { const [key, ...rest] = arg.split('='); flags[key!] = rest.join('='); }
  }
  return { labels, mounts, flags, image: args.at(-1)! };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'managed-cost-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const project: any = { id: 7, executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  const stores = {
    usersRead: { list: () => [{ id: 1 }], isAdmin: () => false, mayUsePlugin: () => true },
    userProjects: { canAccess: () => true, canManage: () => true },
    projects: { get: (id: number) => (id === 7 ? project : null), list: () => [project], beginDeletion: () => true, finishDeletion: vi.fn(() => true) },
  };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config: {} };
  initSandboxDb(ctx);

  const containers = new Map<string, ReturnType<typeof parseCreate>>();
  const volumes = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  let state = 'created';

  // The guest helper answers the operation it was handed on stdin, so a test that asks for a read cannot
  // silently be served a stat.
  const guestReply = (input: string | undefined) => {
    const op = JSON.parse(String(input ?? '{}'));
    const entry = { path: op.path, kind: 'file', size: 5, modifiedAt: '2026-01-01T00:00:00Z', version: 'v1' };
    if (op.kind === 'stat') return { ok: true, result: { kind: 'stat', entry } };
    if (op.kind === 'list') return { ok: true, result: { kind: 'list', entries: [entry], truncated: false, nextCursor: null } };
    if (op.kind === 'read') return { ok: true, result: { kind: 'read', base64: Buffer.from('hello').toString('base64'), version: 'v1', totalBytes: 5 } };
    return { ok: false, error: { code: 'unsupported', message: `unexpected ${op.kind}` } };
  };

  const containerRow = (name: string) => {
    const created = containers.get(name)!;
    const memory = Number(created.flags['--memory']!.replace(/m$/, '')) * 1024 * 1024;
    return {
      Id: CONTAINER_ID, Name: name, ImageName: created.image, Config: { Labels: created.labels }, State: { Status: state },
      HostConfig: {
        Privileged: false, NetworkMode: created.flags['--network'], Memory: memory, MemorySwap: memory,
        NanoCpus: Number(created.flags['--cpus']) * 1e9, PidsLimit: Number(created.flags['--pids-limit']),
        PidMode: 'private', IpcMode: created.flags['--ipc'], ReadonlyRootfs: false, PortBindings: {},
      },
      Mounts: created.mounts.map((mount) => ({
        Type: mount.type, Destination: mount.target, Source: mount.source,
        Name: mount.type === 'volume' ? mount.source : undefined, RW: !mount.readOnly,
      })),
    };
  };

  const executor = {
    run: vi.fn(async (_file: string, argv: string[], options: any) => {
      const args = argv.slice();
      calls.push({ args, input: options?.input === undefined ? undefined : String(options.input) });
      const reply = (code: number, stdout = '') => ({ code, stdout, stderr: '', truncated: false });
      if (args[0] === 'info') return reply(0, args[2] === '{{.Host.Security.Rootless}}' ? 'true' : JSON.stringify({ host: { security: { rootless: true } }, version: {}, store: {} }));
      if (args[0] === 'image' && args[1] === 'exists') return reply(0);
      if (args[0] === 'container' && args[1] === 'exists') return reply(containers.has(args[2]!) ? 0 : 1);
      if (args[0] === 'volume' && args[1] === 'exists') return reply(volumes.has(args[2]!) ? 0 : 1);
      if (args[0] === 'volume' && args[1] === 'inspect') {
        const names = args.slice(2);
        const rows = names.map((name) => volumes.get(name)).filter(Boolean);
        if (rows.length !== names.length) return reply(125, '[]');
        return reply(0, JSON.stringify(rows));
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        const created = parseCreate(args);
        const name = args.at(-1)!;
        // `--opt` repeats, so the device comes from the raw pairs rather than the flag record.
        const device = args.filter((value, index) => args[index - 1] === '--opt').find((value) => value.startsWith('device='))!;
        volumes.set(name, { Name: name, Labels: created.labels, Driver: 'local', Options: { type: 'none', o: 'bind', device: device.slice('device='.length) } });
        return reply(0);
      }
      if (args[0] === 'create') { containers.set(args[2]!, parseCreate(args)); return reply(0); }
      if (args[0] === 'start') { state = 'running'; return reply(0); }
      if (args[0] === 'inspect') {
        const name = args.at(-1)!;
        if (!containers.has(name)) return reply(125, '[]');
        return reply(0, JSON.stringify([containerRow(name)]));
      }
      if (args[0] === 'exec') {
        // The launcher: `exec --interactive <id> systemd-run … -- <argv>`.
        if (args[1] === '--interactive') {
          if (args.includes('/usr/bin/python3')) return reply(0, JSON.stringify(guestReply(options?.input)));
          return reply(0);
        }
        // A launcher that settled normally leaves no unit behind; that is the cheap release path.
        if (args.includes('show')) return reply(0, 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n');
        return reply(0);
      }
      return reply(0);
    }),
  };

  const podman = new PodmanClient({ executor: executor as never });
  const storage = new ContainerStorage(podman);
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, podman, storage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, calls, executor, root };
}

const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 } as const;

async function provisioned() {
  const state = setup();
  await state.runtime.requestEnvironment({ ...input, requestId: 'cost-start', action: { kind: 'start' } });
  await state.runtime.reconcile();
  expect((await state.runtime.environmentFor(input)).state).toBe('running');
  state.calls.length = 0;
  return state;
}

const operationFor = (kind: 'stat' | 'list' | 'read') => kind === 'read'
  ? { kind, path: '/workspace/tiny.txt', offset: 0, length: 64, maxBytes: 64 }
  : kind === 'list' ? { kind, path: '/workspace', limit: 100 } : { kind, path: '/workspace/tiny.txt' };

describe('managed file operation Podman cost', () => {
  it.each(['stat', 'list', 'read'] as const)('issues a bounded number of Podman subprocesses for one %s', async (kind) => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor(kind) });

    // Five, and which five: container existence, container inspection, one batched inspection of all
    // three project volumes, the guest launcher, and the release probe. The pre-repair path issued 33 for
    // the same work. This is an exact figure on purpose — a sixth invocation is a regression worth a
    // conversation, not something to absorb into a bound with room in it.
    expect(state.calls.length).toBe(5);

    // Exactly one guest execution.
    expect(state.calls.filter((call) => call.args[1] === '--interactive')).toHaveLength(1);

    // One durable lease, deleted exactly once — no row may survive a successful operation.
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  it('never repeats the execution release after the client already cleaned the unit', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    // `systemctl show` is the release probe. Two of them means the release ran twice.
    expect(state.calls.filter((call) => call.args.includes('show'))).toHaveLength(1);
    expect(state.calls.filter((call) => call.args.includes('mask') || call.args.includes('unmask'))).toHaveLength(0);
  });

  it('runs no completion-artifact cleanup for a file helper that never armed capture', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    expect(state.calls.filter((call) => call.args.includes('/usr/bin/rm'))).toHaveLength(0);
  });

  // Retiring the durable lease without a full release is safe ONLY because the client settles the guest
  // itself. When it reports that it could not, the lease is what still fences the environment against a
  // lifecycle change while an execution may be live, so it must survive rather than be tidied away.
  it('keeps the durable lease when the client could not settle the guest', async () => {
    const state = await provisioned();
    const original = state.executor.run.getMockImplementation()!;
    state.executor.run.mockImplementation(async (file, args, options) => {
      // Break termination verification: the unit reports neither retired nor cleanly masked.
      if (args[0] === 'exec' && args.includes('show')) return { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/live\n', stderr: '', truncated: false };
      return original(file, args, options);
    });

    await expect(state.runtime.projectFiles({ ...input, operation: operationFor('stat') })).rejects.toThrow(/termination could not be verified/i);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 1 });
  });

  it('verifies ownership once for the whole fenced execution', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    // One container inspection, and one batched volume inspection for all three project volumes.
    expect(state.calls.filter((call) => call.args[0] === 'inspect')).toHaveLength(1);
    expect(state.calls.filter((call) => call.args[0] === 'volume' && call.args[1] === 'inspect')).toHaveLength(1);
  });
});
