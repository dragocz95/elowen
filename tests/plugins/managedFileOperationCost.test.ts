import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { NspawnClient, UID_RANGE_SIZE, envelopePaths, unitFor } from '../../plugins/sandbox/lib/nspawn.mjs';
import { ContainerStorage } from '../../plugins/sandbox/lib/containerStorage.mjs';

/** What one managed file operation COSTS, measured in host subprocesses.
 *
 *  The audit measured a trivial guest file operation issuing about 33 container-runtime invocations, each
 *  one a process spawn of its own. At the 100-400 ms a rootless runtime start-up actually took on the
 *  measured host, that fixed transport — not the file, not the model — is what made an empty directory
 *  listing cost seconds. Every invocation counted here is a real process, so the count IS the latency
 *  budget, and asserting it is how a change that reintroduces a redundant ownership proof or a second
 *  release gets caught by a test rather than by someone waiting on an editor.
 *
 *  Only the executor is faked. The real NspawnClient, ContainerStorage and environment runtime sit above
 *  it, so the ownership, generation, lease and cleanup invariants under test are the shipped ones. The
 *  fake models the host side of a machine — the two envelope files, the disk identity record and what
 *  `systemctl show` says about the unit — from the privileged requests it is actually given, so a
 *  specification the client never wrote an envelope for cannot inspect successfully. */

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

interface Call { file: string; args: string[]; request?: any; input?: string }

const UID_BASE = 1073741824;
/** The guest verdict shape the privileged helper answers an `exec` with. */
const verdict = (stdout = '', exitCode = 0) => ({ ok: true, exitCode, signal: null, timedOut: false,
  truncated: false, stdout: Buffer.from(stdout).toString('base64'), stderr: '' });
/** What `systemctl show` inside the guest says about a unit that settled and was collected, which is the
 *  cheap release path: proven absence, and no mask or unmask round trip behind it. */
const COLLECTED = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n';
const MASKED = 'LoadState=masked\nActiveState=inactive\nSubState=dead\nControlGroup=\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'managed-cost-'));
  const configRoot = join(root, 'config');
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
  const ctx: any = { db: () => db, host: { stores: () => stores }, currentAccountUserId: () => null, currentAccess: () => ({ readOnly: false }),
    config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  initSandboxDb(ctx);

  const masked = new Set<string>();
  const calls: Call[] = [];
  /** The unit as the manager reports it, written by the privileged `write-envelope` and moved by the
   *  lifecycle commands below — never by the test, so a machine this client did not create cannot pass
   *  its own ownership proof. */
  let unit: Record<string, string> | null = null;

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

  /** The privileged side, answering the operations the client actually sends it. `write-envelope` is
   *  where a machine comes into existence on this host: it writes the two root-owned configuration files
   *  and the disk's identity record from the request's OWN fields, which is what makes the ownership
   *  proof below meaningful — every field it compares came from the specification, not from the test. */
  const helper = async (request: any, input?: Buffer) => {
    if (request.op === 'status') {
      return { ok: true, ready: true, items: [{ id: 'unit:elowen-machine', label: 'Machine unit template', ok: true, detail: 'installed and loaded' }] };
    }
    if (request.op === 'write-envelope') {
      const envelope = envelopePaths(request.machine, configRoot);
      for (const path of Object.values(envelope)) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(envelope.nspawn, '[Exec]\nBoot=on\n', { mode: 0o644 });
      writeFileSync(envelope.dropIn, `[Service]\nCPUQuota=${request.limits.cpus * 100}%\n`, { mode: 0o644 });
      const rootfs = realpathSync(diskRootfs!);
      mkdirSync(join(dirname(diskRootfs!), '.elowen'), { recursive: true });
      writeFileSync(join(dirname(diskRootfs!), '.elowen', 'identity.json'), JSON.stringify({
        namespace: request.namespace, kind: request.kind, resource: request.resource, generation: request.generation,
        diskId: request.diskId, machine: request.machine, runtime: 'nspawn', specHash: request.specHash,
        uidBase: UID_BASE, uidSize: UID_RANGE_SIZE }), { mode: 0o640 });
      unit = {
        LoadState: 'loaded',
        FragmentPath: join(configRoot, '/etc/systemd/system/elowen-machine@.service'),
        DropInPaths: envelope.dropIn,
        Environment: `ELOWEN_MACHINE_DIRECTORY=${rootfs}`,
        ActiveState: 'inactive', SubState: 'dead', FreezerState: 'running',
        MemoryMax: String(request.limits.memoryMb * 1024 * 1024), TasksMax: String(request.limits.pidsLimit),
        CPUQuotaPerSecUSec: request.limits.cpus === 1 ? '1s' : `${request.limits.cpus * 1000}ms`, Slice: 'machine.slice',
      };
      return { ok: true };
    }
    if (request.op === 'exec') {
      const argv: string[] = request.argv;
      if (argv[0] === '/usr/bin/python3') {
        // The hook runs INSIDE the guest execution, while the lease that operation holds is held.
        const body = input === undefined ? '{}' : input.toString('utf8');
        if (hook) await hook(JSON.parse(body));
        return verdict(JSON.stringify(guestReply(body)));
      }
      if (argv[0] === '/usr/bin/systemctl') {
        // Masking a unit changes what `show` says about it afterwards, and a cancellation VERIFIES that
        // change before it calls the guest terminated. A fake that always answered "no such unit" would
        // let a cancellation look impossible on a path that works.
        const guestUnit = argv.at(-1)!;
        if (argv.includes('mask')) masked.add(guestUnit);
        if (argv.includes('unmask')) masked.delete(guestUnit);
        if (argv.includes('show')) return verdict(guestShow(guestUnit));
        return verdict();
      }
      return verdict();
    }
    return { ok: true };
  };
  /** Overridable so a test can break exactly one fact: what the guest reports about a leased unit. */
  let guestShow = (guestUnit: string) => (masked.has(guestUnit) ? MASKED : COLLECTED);

  let diskRootfs: string | null = null;

  const executor = {
    run: vi.fn(async (file: string, argv: string[], options: any) => {
      const args = argv.slice();
      const call: Call = { file, args };
      calls.push(call);
      const reply = (code: number, stdout = '') => ({ code, stdout, stderr: '', truncated: false });
      const render = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
      if (file === '/usr/bin/systemctl') {
        if (args[0] === 'show') return reply(0, unit ? render(unit) : '');
        if (args[0] === 'start') { unit!.ActiveState = 'active'; unit!.SubState = 'running'; return reply(0); }
        if (args[0] === 'stop') { unit!.ActiveState = 'inactive'; unit!.SubState = 'dead'; return reply(0); }
        return reply(0);
      }
      if (file === '/usr/bin/machinectl') {
        if (args[0] === 'show') {
          if (!unit || unit.ActiveState !== 'active') return reply(1, '');
          return reply(0, render({ Unit: unitFor(args[1]!), RootDirectory: realpathSync(diskRootfs!) }));
        }
        if (args[0] === 'list') return reply(0, unit?.ActiveState === 'active' ? `${machineName} container systemd-nspawn\n` : '');
        return reply(0);
      }
      if (file === '/usr/bin/sudo') {
        const frame: Buffer = Buffer.isBuffer(options?.input) ? options.input : Buffer.from(String(options?.input ?? ''));
        const length = Number(frame.subarray(0, 8).toString('latin1'));
        const request = JSON.parse(frame.subarray(9, 9 + length).toString('utf8'));
        call.request = request;
        call.input = frame.subarray(9 + length).toString('utf8');
        return reply(0, JSON.stringify(await helper(request, frame.subarray(9 + length))));
      }
      return reply(0);
    }),
  };

  let machineName = '';
  const artifacts = { status: vi.fn(() => ({ published: true, present: true })), ensure: vi.fn(), collect: vi.fn(() => []) };
  const nspawn = new NspawnClient({ executor: executor as never, artifacts, configRoot, namespace: 'elowen' });
  const storage = new ContainerStorage(nspawn);
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: root, nspawn, storage, daemon: true });
  cleanup.push(() => { runtime.dispose(); sql.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, db, calls, executor, root, files, versionOf,
    setDisk: (rootfsPath: string, name: string) => { diskRootfs = rootfsPath; machineName = name; },
    setGuestShow: (fn: (guestUnit: string) => string) => { guestShow = fn; },
    setAuthorizeHook: (fn: (() => void) | null) => { authorizeHook = fn; },
    setHook: (fn: ((op: any) => Promise<void>) | null) => { hook = fn; } };
}

const input = { project: { kind: 'managed', projectId: 7 }, accountUserId: 1 } as const;

interface DiskRecord { id: string; rootfsPath: string; sourceImage: string; components: { component: string; path: string }[] }

/** An environment that already exists, which is what every measurement below is about: the cost of ONE
 *  file operation, not of the first start that built the environment.
 *
 *  The disk manifest is the durable record that says this disk is materialized. Writing it (and the
 *  directories it names) makes `ContainerStorage` adopt the disk by its record, exactly as it does on
 *  every start after the first, instead of unpacking a published root filesystem into it — which is real
 *  privileged filesystem work no faked executor can perform. Everything else the start does is the
 *  product's own path: the runtime is decided against the host readiness answer, the envelope is written
 *  by the privileged side, and the machine is started and proved through the shipped ownership check. */
function existing(state: ReturnType<typeof setup>) {
  const row = state.db.prepare('SELECT spec_json FROM p_sandbox_runtimes').get() as { spec_json: string };
  const stored = JSON.parse(row.spec_json);
  const spec = stored.input as { resource: { kind: string; id: number }; disk: DiskRecord };
  mkdirSync(spec.disk.rootfsPath, { recursive: true, mode: 0o755 });
  for (const component of spec.disk.components) mkdirSync(component.path, { recursive: true });
  writeFileSync(join(dirname(spec.disk.rootfsPath), 'disk.json'), JSON.stringify({
    resource: spec.resource, diskId: spec.disk.id, format: 2, sourceImage: spec.disk.sourceImage,
    rootfsPath: spec.disk.rootfsPath, components: spec.disk.components,
    createdAt: '2026-01-01T00:00:00.000Z', materialized: true,
  }));
  state.setDisk(spec.disk.rootfsPath, `elowen-project-7-g${stored.input.generation}`);
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

/** How a call reads in the count below: the control tool and its verb, or the privileged operation and
 *  the guest verb it carries, because every privileged round trip is one `sudo` process whatever it is. */
const shape = (call: { file: string; args: string[]; request?: any }) => (call.request
  ? `privileged ${call.request.op}${call.request.argv ? ` ${call.request.argv[0]}` : ''}`
  : `${call.file.split('/').at(-1)} ${call.args[0]}`);

describe('managed file operation host cost', () => {
  it.each(['stat', 'list', 'read'] as const)('issues a bounded number of host subprocesses for one %s', async (kind) => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor(kind) });

    // Four, and which four: the unit half of the ownership proof, the machine-manager half, the guest
    // launcher, and the release probe. The pre-repair container path issued 33 for the same work. What is
    // NOT here is as much the point as what is: the envelope's own presence is two `lstat` calls rather
    // than a process, and a machine holds no named volume handles to inspect. This is an exact figure on
    // purpose — a fifth invocation is a regression worth a conversation, not something to absorb into a
    // bound with room in it.
    expect(state.calls.map(shape)).toEqual([
      'systemctl show', 'machinectl show', 'privileged exec /usr/bin/python3', 'privileged exec /usr/bin/systemctl',
    ]);

    // Exactly one guest execution of the file helper.
    expect(state.calls.filter((call) => call.request?.argv?.[0] === '/usr/bin/python3')).toHaveLength(1);

    // One durable lease, deleted exactly once — no row may survive a successful operation.
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 0 });
  });

  it('never repeats the execution release after the client already cleaned the unit', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    const guest = state.calls.filter((call) => call.request?.op === 'exec').map((call) => call.request.argv);
    // The guest `systemctl show` is the release probe. Two of them means the release ran twice.
    expect(guest.filter((argv: string[]) => argv.includes('show'))).toHaveLength(1);
    expect(guest.filter((argv: string[]) => argv.includes('mask') || argv.includes('unmask'))).toHaveLength(0);
  });

  it('runs no completion-artifact cleanup for a file helper that never armed capture', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    // The nspawn transport carries no completion capture at all, so there is never an artifact to remove;
    // the cleanup that used to be paid on every managed file operation cannot come back through this path.
    expect(state.calls.filter((call) => call.request?.argv?.includes('/usr/bin/rm'))).toHaveLength(0);
  });

  // Retiring the durable lease without a full release is safe ONLY because the client settles the guest
  // itself. When it reports that it could not, the lease is what still fences the environment against a
  // lifecycle change while an execution may be live, so it must survive rather than be tidied away.
  it('keeps the durable lease when the client could not settle the guest', async () => {
    const state = await provisioned();
    // Break termination verification: the unit reports neither retired nor cleanly masked.
    state.setGuestShow(() => 'LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/live\n');

    await expect(state.runtime.projectFiles({ ...input, operation: operationFor('stat') })).rejects.toThrow(/termination could not be verified/i);
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM p_sandbox_execution_leases').get()).toEqual({ n: 1 });
  });

  it('verifies ownership once for the whole fenced execution', async () => {
    const state = await provisioned();
    await state.runtime.projectFiles({ ...input, operation: operationFor('stat') });
    // One ownership proof for the whole execution, and it is one round trip per host fact rather than per
    // disk component: the disk's component directories are binds recorded in the envelope the unit
    // already names, so a per-component round trip would be a new cost with nothing left to verify.
    expect(state.calls.filter((call) => call.file === '/usr/bin/systemctl' && call.args[0] === 'show')).toHaveLength(1);
    expect(state.calls.filter((call) => call.file === '/usr/bin/machinectl' && call.args[0] === 'show')).toHaveLength(1);
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
