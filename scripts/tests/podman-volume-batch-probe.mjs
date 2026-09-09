/** Does the real `podman volume inspect` on THIS host answer for several names at once, in the order
 *  asked, and fail usefully when one of them is absent? The ownership check now issues one invocation for
 *  a whole spec instead of an existence probe and an inspection per volume, and a fake that agrees proves
 *  nothing about the binary that actually ships.
 *
 *  Runs against a PRIVATE store only. `isolatedPodmanOptions` creates an exclusive graphroot, runroot,
 *  tmpdir, runtime dir and HOME, and the guard below refuses any launch that does not carry all of them,
 *  so the account's real container store is never read or written. No image and no container is needed:
 *  local bind volumes are enough to answer the question.
 *
 *  Usage: node scripts/tests/podman-volume-batch-probe.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PodmanClient, SpawnExecutor, isolatedPodmanOptions } from '../../plugins/sandbox/lib/podman.mjs';
import { createContainerSpec } from '../../plugins/sandbox/lib/containerSpec.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ep-'));
const isolation = isolatedPodmanOptions(join(scratch, 'podman'), `probe-${randomBytes(6).toString('hex')}`);
const paths = isolation.isolation;
const prefix = ['--root', paths.storage, '--runroot', paths.runroot, '--tmpdir', paths.tmp, '--storage-driver', 'vfs'];
const env = { HOME: paths.home, XDG_RUNTIME_DIR: paths.runtime, TMPDIR: paths.tmp, USER: 'probe', LOGNAME: 'probe', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
const native = new SpawnExecutor();
const calls = [];

/** Every launch is checked against the private store before it is allowed to run. */
const guarded = { run: async (file, args, options) => {
  assert.equal(file, '/usr/bin/podman');
  assert.deepEqual(args.slice(0, prefix.length), prefix, 'a launch escaped the private store');
  assert.equal(options.env.HOME, paths.home);
  assert.equal(options.env.XDG_RUNTIME_DIR, paths.runtime);
  assert.equal(options.env.TMPDIR, paths.tmp);
  const started = process.hrtime.bigint();
  const result = await native.run(file, args, options);
  calls.push({ command: args.slice(prefix.length), ms: Number(process.hrtime.bigint() - started) / 1e6, code: result.code });
  return result;
} };

const raw = async (...command) => {
  const started = process.hrtime.bigint();
  const result = await native.run('/usr/bin/podman', [...prefix, ...command], { env, timeoutMs: 120000, outputLimitBytes: 1 << 20 });
  return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const client = new PodmanClient({ ...isolation, executor: guarded });
const store = join(scratch, 'store');
mkdirSync(store, { recursive: true });
const spec = createContainerSpec(
  { resource: { kind: 'project', id: 7 }, generation: 1, image: 'localhost/unused:probe' },
  { namespace: paths.namespace, sandboxDataDir: store, sitesDataDir: join(scratch, 'sites'), siteSourcesDir: join(scratch, 'src'), siteBrokerDir: join(scratch, 'brokers') },
);
const names = spec.volumes.map((volume) => volume.name);
const report = { podmanVersion: null, volumes: names.length };

try {
  report.podmanVersion = (await client.info()).version;
  for (const volume of spec.volumes) { mkdirSync(volume.path, { recursive: true }); await client.ensureVolume(spec, volume.component); }

  // 1. Several names, one invocation, answered in order.
  const batched = await raw('volume', 'inspect', ...names);
  assert.equal(batched.code, 0, `batched volume inspect exited ${batched.code}: ${batched.stderr.trim()}`);
  const rows = JSON.parse(batched.stdout);
  assert.equal(rows.length, names.length, `asked for ${names.length} volumes, got ${rows.length} rows`);
  assert.deepEqual(rows.map((row) => row.Name), names, 'batched volume inspect did not preserve the requested order');
  report.batchedAnswersInOrder = true;

  // 2. What one spec-wide ownership check costs now, against what the loop it replaced cost.
  const samples = 7;
  const batchedMs = [];
  const loopMs = [];
  for (let run = 0; run < samples; run += 1) {
    batchedMs.push((await raw('volume', 'inspect', ...names)).ms);
    let total = 0;
    for (const name of names) {
      total += (await raw('volume', 'exists', name)).ms;
      total += (await raw('volume', 'inspect', name)).ms;
    }
    loopMs.push(total);
  }
  report.oneBatchedInspectMs = Number(median(batchedMs).toFixed(1));
  report.perVolumeLoopMs = Number(median(loopMs).toFixed(1));
  report.savedPerOwnershipCheckMs = Number((median(loopMs) - median(batchedMs)).toFixed(1));
  report.subprocessMedianMs = Number(median(batchedMs).toFixed(1));

  // 3. A missing volume must be reported, never quietly dropped from a short answer.
  await client.removeVolume(spec, 'data');
  const short = await raw('volume', 'inspect', ...names);
  report.missingBatch = { code: short.code, rows: (() => { try { return JSON.parse(short.stdout).length; } catch { return null; } })() };
  assert.notEqual(short.code, 0, 'a batch naming a removed volume still exited 0');

  let missing = null;
  try { await client.inspectVolume(spec, 'data'); } catch (error) { missing = error.message; }
  assert.match(String(missing), /Owned volume is missing/, `a removed volume reported "${missing}"`);
  report.missingReportedAs = missing;

  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message), ...report }, null, 2));
  process.exitCode = 1;
} finally {
  for (const volume of spec.volumes) { try { await client.removeVolume(spec, volume.component); } catch { /* best effort */ } }
  rmSync(scratch, { recursive: true, force: true });
}
