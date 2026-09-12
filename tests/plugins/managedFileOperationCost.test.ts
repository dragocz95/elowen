import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 *  inspect with the shape the client demands. A disk-backed envelope ends in `<rootfs> /sbin/init` rather
 *  than an image, so what the trailing argument means depends on `--rootfs`. */
function parseCreate(args: string[]) {
  const labels: Record<string, string> = {};
  const mounts: { type: string; source: string; target: string; readOnly: boolean }[] = [];
  const flags: Record<string, string> = {};
  let name = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--name') { name = args[++index]!; continue; }
    if (arg === '--label') { const [key, ...rest] = args[++index]!.split('='); labels[key!] = rest.join('='); continue; }
    if (arg === '--mount') {
      const parts = Object.fromEntries(args[++index]!.split(',').map((part) => part.split('=') as [string, string]));
      mounts.push({ type: parts.type!, source: parts.src!, target: parts.dst!, readOnly: 'ro' in parts });
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) { const [key, ...rest] = arg.split('='); flags[key!] = rest.join('='); }
  }
  const rootfs = args.includes('--rootfs') ? args.at(-2)! : null;
  return { labels, mounts, flags, name, rootfs, image: rootfs ? '' : args.at(-1)! };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'managed-cost-'));
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const project: any = { id: 7, executionKind: 'managed', lifecycle: 'active', path: '/not-a-host-path' };
  let authorizeHook: (() => void) | null = null;
  const stores = {
    usersRead: { list: () => [{ id: 1 }], isAdmin: () => false, mayUsePlugin: () => true },
    // `canAccess` is consulted by `authorize`, which runs INSIDE mint and after `ready` has returned its
    // row. A test needing something to happen in exactly that window hangs it here.
    userProjects: { canAccess: () => { authorizeHook?.(); return true; }, canManage: () => true },
    projects: { get: (id: number) => (id === 7 ? project : null), list: () => [project], beginDeletion: () => true, finishDeletion: vi.fn(() => true) },
  };
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }), config: {} };
  initSandboxDb(ctx);

  const masked = new Set<string>();
  const containers = new Map<string, ReturnType<typeof parseCreate>>();
  const volumes = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  let state = 'created';

  // A small filesystem of its own, so a write is observable by a later read and the compare-and-swap has
  // something real to swap against. `hook` lets a test hold an operation open inside the guest, which is
  // how overlap between concurrent operations is observed rather than assumed.
  const files = new Map<string, string>([['/workspace/tiny.txt', 'hello']]);
  const versionOf = (body: string) => `v${body.length}:${body.slice(0, 8)}`;
  let hook: ((op: any) => Promise<void>) | null = null;

  // The guest helper answers the operation it was handed on stdin, so a test that asks for a read cannot
  // silently be served a stat.
  const guestReply = (input: string | undefined) => {
    const op = JSON.parse(String(input ?? '{}'));
    const body = files.get(op.path);
    const entry = { path: op.path, kind: 'file', size: body?.length ?? 0, modifiedAt: '2026-01-01T00:00:00Z', version: versionOf(body ?? '') };
    if (op.kind === 'stat') return { ok: true, result: { kind: 'stat', entry: body === undefined ? null : entry } };
    if (op.kind === 'list') return { ok: true, result: { kind: 'list', entries: [entry], truncated: false, nextCursor: null } };
    if (op.kind === 'walk') return { ok: true, result: { kind: 'walk', root: op.path, rootKind: 'directory', entries: [...files.keys()].map(path => ({ path, kind: 'file', size: files.get(path)!.length, mtime: 1767225600000 })), truncated: false } };
    if (op.kind === 'read') {
      if (body === undefined) return { ok: false, error: { code: 'not_found', message: `No such file: ${op.path}` } };
      return { ok: true, result: { kind: 'read', base64: Buffer.from(body).toString('base64'), version: versionOf(body), totalBytes: body.length } };
    }
    if (op.kind === 'write') {
      const current = body === undefined ? null : versionOf(body);
      if (current !== (op.expectedVersion ?? null)) return { ok: false, error: { code: 'version_conflict', message: 'File changed while writing' } };
      // A rename over the target: a reader sees the whole old body or the whole new one, never a mixture.
      const next = Buffer.from(op.base64, 'base64').toString();
      files.set(op.path, next);
      return { ok: true, result: { kind: 'write', entry: { ...entry, size: next.length, version: versionOf(next) } } };
    }
    return { ok: false, error: { code: 'unsupported', message: `unexpected ${op.kind}` } };
  };

  const containerRow = (name: string) => {
    const created = containers.get(name)!;
    const memory = Number(created.flags['--memory']!.replace(/m$/, '')) * 1024 * 1024;
    // A disk-backed envelope carries no image at all: the client holds `Image`/`ImageName` empty, the
    // root filesystem path and the systemd entry point against the specification, and refuses the row
    // when any of them drifts.
    return {
      Id: CONTAINER_ID, Name: name, Image: created.rootfs ? '' : created.image, ImageName: created.rootfs ? '' : created.image,
      ...(created.rootfs ? { Rootfs: realpathSync(created.rootfs), Path: '/sbin/init' } : {}),
      Config: { Labels: created.labels, ...(created.rootfs ? { SystemdMode: true, StopSignal: 37 } : {}) }, State: { Status: state },
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
        const device = args.filter((_, index) => args[index - 1] === '--opt').find((value) => value.startsWith('device='))!;
        volumes.set(name, { Name: name, Labels: created.labels, Driver: 'local', Options: { type: 'none', o: 'bind', device: device.slice('device='.length) } });
        return reply(0);
      }
      if (args[0] === 'create') { const created = parseCreate(args); containers.set(created.name, created); return reply(0); }
      if (args[0] === 'start') { state = 'running'; return reply(0); }
      if (args[0] === 'inspect') {
        const name = args.at(-1)!;
        if (!containers.has(name)) return reply(125, '[]');
        return reply(0, JSON.stringify([containerRow(name)]));
      }
      if (args[0] === 'exec') {
        // The launcher: `exec --interactive <id> systemd-run … -- <argv>`.
        if (args[1] === '--interactive') {
          if (args.includes('/usr/bin/python3')) {
            // The hook runs INSIDE the guest execution, while the lease that operation holds is held.
            if (hook) await hook(JSON.parse(String(options?.input ?? '{}')));
            return reply(0, JSON.stringify(guestReply(options?.input)));
          }
          return reply(0);
        }
        // Masking a unit changes what `show` says about it afterwards, and a cancellation VERIFIES that
        // change before it calls the guest terminated. A fake that always answered "no such unit" would
        // let a cancellation look impossible on a path that works.
        const unit = args.at(-1)!;
        if (args.includes('mask') && !args.includes('unmask')) masked.add(unit);
        if (args.includes('unmask')) masked.delete(unit);
        if (args.includes('show')) {
          return masked.has(unit)
            ? reply(0, 'LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n')
            // A launcher that settled normally leaves no unit behind; that is the cheap release path.
            : reply(0, 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n');
        }
        return reply(0);
      }
      return reply(0);
    }),
  };

  const podman = new PodmanClient({ executor: executor as never });
  const storage = new ContainerStorage(podman);
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, podman, storage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, calls, executor, root, files, versionOf,
    setAuthorizeHook: (fn: (() => void) | null) => { authorizeHook = fn; },
    setHook: (fn: ((op: any) => Promise<void>) | null) => { hook = fn; } };
}

const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 } as const;

interface DiskRecord { id: string; rootfsPath: string; sourceImage: string; components: { component: string; path: string }[] }

/** An environment that already exists, which is what every measurement below is about: the cost of ONE
 *  file operation, not of the first start that built the environment. Two things separate that state from
 *  a row the runtime has only just inserted, and both are reached the way the product reaches them.
 *
 *  The marker `runtimePending` is what sends a NEW environment to systemd-nspawn (`decideRuntime`);
 *  clearing it is how the sibling environment suites express an environment that predates the machine
 *  runtime, and a Podman environment is the subject here — it is what every environment created before
 *  `migrate-runtime` still runs on.
 *
 *  The disk manifest is the durable record that says this disk is materialized. Writing it (and the
 *  directories it names) makes `ContainerStorage` adopt the disk by its record, exactly as it does on
 *  every start after the first, instead of building a root filesystem out of the base image — which is
 *  real filesystem work no faked executor can perform. */
function existing(state: ReturnType<typeof setup>) {
  state.db.prepare("UPDATE p_sandbox_runtimes SET spec_json=json_remove(spec_json,'$.runtimePending')").run();
  const row = state.db.prepare('SELECT spec_json FROM p_sandbox_runtimes').get() as { spec_json: string };
  const spec = JSON.parse(row.spec_json).input as { resource: { kind: string; id: number }; disk: DiskRecord };
  mkdirSync(spec.disk.rootfsPath, { recursive: true });
  for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true });
  writeFileSync(join(dirname(spec.disk.rootfsPath), 'disk.json'), JSON.stringify({
    resource: spec.resource, diskId: spec.disk.id, format: 2, sourceImage: spec.disk.sourceImage,
    rootfsPath: spec.disk.rootfsPath, components: spec.disk.components,
    createdAt: '2026-01-01T00:00:00.000Z', materialized: true,
  }));
}

async function provisioned() {
  const state = setup();
  await state.runtime.requestEnvironment({ ...input, requestId: 'cost-start', action: { kind: 'start' } });
  existing(state);
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

    // Four, and which four: container existence, container inspection, the guest launcher, and the
    // release probe. The pre-repair path issued 33 for the same work. The fifth this suite once counted —
    // one batched inspection of all three project volumes — went away with the volumes themselves: a
    // disk-backed envelope bind mounts the disk's own directories and holds no named volume handles, so
    // ownership has nothing to inspect beyond the container. This is an exact figure on purpose — a fifth
    // invocation is a regression worth a conversation, not something to absorb into a bound with room in
    // it.
    expect(state.calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'container exists', 'inspect --type', 'exec --interactive', `exec ${CONTAINER_ID}`,
    ]);

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
    // One container inspection for the whole execution, and no volume inspection at all: the disk's
    // component directories are bind mounts held against the specification by that same inspection, so a
    // per-component volume round trip would be a new cost with nothing left to verify.
    expect(state.calls.filter((call) => call.args[0] === 'inspect')).toHaveLength(1);
    expect(state.calls.filter((call) => call.args[0] === 'volume' && call.args[1] === 'inspect')).toHaveLength(0);
  });
});

/** WHICH file operations wait for each other.
 *
 *  One exclusive repository lease used to wrap every file operation, so a batch of independent reads ran
 *  strictly one at a time and queued behind whatever mutation was in front of them. Only the operations
 *  that change the tree serialize now. Nothing that made a read safe came from that lease, and these
 *  tests pin both halves of that claim: reads overlap, mutations do not, and everything a caller could
 *  observe about correctness is unchanged. */
describe('managed file operation concurrency', () => {
  /** Runs `work` while recording how many guest operations were in flight at once. */
  async function overlap(state: Awaited<ReturnType<typeof provisioned>>, work: () => Promise<unknown>) {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    state.setHook(async (op) => {
      seen.push(op.kind);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Long enough that a serialized pair cannot overlap by accident, short enough that these tests add
      // little wall time to a suite that already runs everything else in parallel around them.
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
    });
    try { return { result: await work(), peak, seen }; } finally { state.setHook(null); }
  }

  const read = (state: any, path = '/workspace/tiny.txt') =>
    state.runtime.projectFiles({ ...input, operation: { kind: 'read', path, offset: 0, length: 64, maxBytes: 64 } });
  const walk = (state: any) => state.runtime.projectFiles({ ...input, operation: { kind: 'walk', path: '/workspace', limit: 10001, skip: [] } });
  const write = (state: any, body: string, expectedVersion: string | null) =>
    state.runtime.projectFiles({ ...input, operation: { kind: 'write', path: '/workspace/tiny.txt', base64: Buffer.from(body).toString('base64'), expectedVersion } });

  it('runs two reads and a walk at the same time', async () => {
    const state = await provisioned();
    const { peak, seen } = await overlap(state, () => Promise.all([read(state), read(state), walk(state)]));
    expect(seen.sort()).toEqual(['read', 'read', 'walk']);
    expect(peak).toBe(3);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  it('still runs mutations one at a time', async () => {
    const state = await provisioned();
    // Each write swaps against the version the one before it produced, so they can only succeed in order.
    const { peak } = await overlap(state, async () => {
      await write(state, 'first', state.versionOf('hello'));
      await write(state, 'second', state.versionOf('first'));
    });
    expect(peak).toBe(1);
    expect(state.files.get('/workspace/tiny.txt')).toBe('second');

    // Issued CONCURRENTLY. Both reach the guest, and the recorder shows they did not run there at the
    // same moment — the conflict below would look identical if the loser had merely been rejected early,
    // so exclusivity has to be measured rather than inferred from it.
    const race = await overlap(state, () => Promise.allSettled([
      write(state, 'a'.repeat(6), state.versionOf('second')),
      write(state, 'b'.repeat(9), state.versionOf('second')),
    ]));
    expect(race.seen).toEqual(['write', 'write']);
    expect(race.peak).toBe(1);

    // Whichever landed first, the other is refused rather than silently overwriting it.
    const settled = race.result as PromiseSettledResult<unknown>[];
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(String((settled.find((entry) => entry.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/version_conflict|changed/i);
  });

  it('never lets a read observe a partly written file', async () => {
    const state = await provisioned();
    const bodies = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const before = state.files.get('/workspace/tiny.txt')!;
      const after = `body-${round}-${'x'.repeat(round)}`;
      const [, ...reads] = await Promise.allSettled([
        write(state, after, state.versionOf(before)),
        read(state), read(state), read(state),
      ]);
      for (const outcome of reads) {
        if (outcome.status === 'rejected') { expect(String(outcome.reason)).toMatch(/conflict|changed/i); continue; }
        bodies.add(Buffer.from((outcome.value as any).base64, 'base64').toString());
      }
    }
    // Every body a read returned is a body some write actually produced — never a mixture of two.
    for (const body of bodies) expect(body === 'hello' || /^body-\d+-x*$/.test(body)).toBe(true);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  /** A promise a test can hold open and release when it chooses. */
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  const files = (state: any) => state.db.prepare("SELECT COUNT(*) AS n FROM p_sandbox_execution_leases WHERE kind='files'").get() as { n: number };

  // Dropping the repository lease from reads must not weaken the durable one, which is what actually
  // fences an environment being stopped, revoked or regenerated underneath a running operation. These
  // two hold the reads open INSIDE the guest and act while they are there, because a test that waits for
  // them to finish first proves nothing about what happens to work in flight.
  it.each([
    ['stopped', async (state: any) => { await state.runtime.requestEnvironment({ ...input, requestId: 'stop-open', action: { kind: 'stop' } }); }],
    ['revoked', async (state: any) => { await state.runtime.revokeProjectAccess({ projectId: 7, accountUserId: 1 }); }],
  ])('observes and cancels every read lease when the environment is %s while they are open', async (_label, act) => {
    const state = await provisioned();
    const held = gate();
    const allIn = gate();
    let entered = 0;
    state.setHook(async () => {
      if ((entered += 1) === 3) allIn.release();
      await held.promise;
    });

    const running = Promise.allSettled([read(state), read(state), walk(state)]);
    await allIn.promise;
    // All three are genuinely suspended inside the guest right now, each holding a durable lease — which
    // is the state a stop or a revocation has to be able to see and act on.
    expect(files(state)).toEqual({ n: 3 });

    await act(state);
    held.release();
    await running;
    state.setHook(null);
    await state.runtime.reconcile();
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  // The generation moves AFTER `ready` has resolved its row and before the lease is minted, which is the
  // window a stale `expectedGeneration` never reaches — that one is refused earlier, by a check the
  // caller supplied the answer to. What has to hold here is that minting itself refuses a row that has
  // gone out of date under a read already on its way.
  it('refuses to mint when the generation moves between ready and mint', async () => {
    const state = await provisioned();
    // `authorize` runs twice per operation: once inside `ready`, which resolves the row, and again inside
    // `mint`. Bumping on the SECOND call lands the change in the gap between them, which is precisely the
    // window under test — bumping on the first would simply hand `ready` the newer row.
    let calls = 0;
    let bumped = false;
    state.setAuthorizeHook(() => {
      if ((calls += 1) !== 2) return;
      bumped = true;
      state.db.prepare("UPDATE p_sandbox_runtimes SET generation=generation+1 WHERE kind='project' AND resource_id='7'").run();
    });

    await expect(read(state)).rejects.toThrow(/environment changed|busy/i);
    state.setAuthorizeHook(null);
    expect(bumped).toBe(true);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  it('refuses a read whose caller names a generation that is already stale', async () => {
    const state = await provisioned();
    const before = (await state.runtime.environmentFor(input)).generation;
    await expect(state.runtime.projectFiles({
      ...input, expectedGeneration: before + 5, operation: { kind: 'read', path: '/workspace/tiny.txt', offset: 0, length: 64, maxBytes: 64 },
    })).rejects.toThrow(/generation/i);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  it('leaves no lease behind when a read fails inside the guest', async () => {
    const state = await provisioned();
    await expect(read(state, '/workspace/absent.txt')).rejects.toThrow(/No such file/);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });
});
