import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_BASE_IMAGE_TAG, PROJECT_CONTAINERFILE } from './containerBaseImage.mjs';
import { assertContainerSpec, executionUnit, hostPath, resourceToken, snapshotReference, volumeLabels } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const isolatedStores = new WeakSet();

function positive(value, max, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name} bound`);
  return value;
}
function validateInput(input) {
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw new Error('Invalid command input');
  if (input !== undefined && Buffer.byteLength(input) > INPUT_LIMIT) throw new Error('Command input exceeds limit');
}

export function cleanPodmanEnv(input = {}) {
  const service = userInfo();
  const uid = input.uid ?? process.getuid?.() ?? service.uid;
  const user = input.user ?? service.username;
  return {
    HOME: input.home ?? service.homedir, USER: user, LOGNAME: user, PATH: SYSTEM_PATH,
    XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

/** Optional integration harnesses must use this complete, private namespace, never account defaults.
 * The caller creates a fresh disposable parent with mkdtemp and retains responsibility for cleanup. */
export function isolatedPodmanOptions(directory, namespace) {
  hostPath(directory);
  resourceToken(namespace);
  if (Buffer.byteLength(join(directory, 'runroot')) > 50) throw new Error('Isolated Podman runroot must fit within 50 bytes; use a short private temporary parent');
  checkedHostPath(dirname(directory));
  // Exclusive creation prevents attaching a test to an existing account store or another harness.
  mkdirSync(directory, { mode: 0o700 });
  const location = (part) => checkedHostPath(join(directory, part), { create: true });
  const isolation = Object.freeze({
    storage: location('storage'), runroot: location('runroot'), tmp: location('tmp'),
    runtime: location('runtime'), home: location('home'), namespace,
  });
  isolatedStores.add(isolation);
  return { isolation };
}

/** Only trusted module code chooses the host executable. Never expose this executor as a plugin control. */
export class SpawnExecutor {
  async run(file, args, options) {
    validateInput(options.input);
    positive(options.timeoutMs, 15 * 60_000, 'timeout');
    positive(options.outputLimitBytes, 16 * 1024 * 1024, 'output');
    options.signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { env: options.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      let truncated = false;
      let failure;
      let killTimer;
      const signal = (name) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
      };
      const terminate = (error) => {
        failure ??= error;
        signal('SIGTERM');
        killTimer ??= setTimeout(() => signal('SIGKILL'), 250);
      };
      const onAbort = () => terminate(new Error('Podman command aborted'));
      const timer = setTimeout(() => terminate(new Error(`Podman command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Abort can land between the initial check and listener registration.
      if (options.signal?.aborted) onAbort();
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
        const combined = Buffer.concat([buffers[stream], chunk]);
        if (combined.length > options.outputLimitBytes) truncated = true;
        buffers[stream] = combined.subarray(Math.max(0, combined.length - options.outputLimitBytes));
      });
      child.once('error', (error) => { failure ??= error; });
      child.stdin.on('error', (error) => {
        // A command may exit without consuming stdin; its exit code still decides success.
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') terminate(error);
      });
      child.once('close', (code) => {
        // The launcher may exit before descendants that ignored TERM and closed their stdio.
        if (failure) signal('SIGKILL');
        clearTimeout(timer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else resolve({ code: code ?? 1, stdout: buffers.stdout.toString('utf8'), stderr: buffers.stderr.toString('utf8'), truncated });
      });
      child.stdin.end(options.input);
    });
  }
}

function labelsMatch(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
}
function legacyLabelsMatch(labels, siteId) {
  return labels?.['io.elowen.site'] === siteId
    && Object.keys(labels).every((key) => !key.startsWith('io.elowen.') || key === 'io.elowen.site');
}
function oneJson(result) {
  if (result.truncated) throw new Error('Podman inspection output exceeded its bound');
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error('Invalid Podman inspection response');
  return rows[0];
}
function volumeFor(spec, component) {
  assertContainerSpec(spec);
  const volume = spec.volumes.find((entry) => entry.component === component);
  if (!volume) throw new Error('Unknown storage component');
  return volume;
}

/** Concrete internal driver. Lifecycle callers serialize operations and recheck authorization before
 * calling it. Every destructive operation validates current identity and targets the immutable ID. */
export class PodmanClient {
  #executor;
  #env;
  #prefix = [];
  #timeoutMs;
  #outputLimit;
  #namespace;

  constructor(options = {}) {
    if (!options.executor && process.getuid?.() === 0) throw new Error('Rootless Podman service account is required');
    this.#executor = options.executor ?? new SpawnExecutor();
    this.#env = cleanPodmanEnv(options);
    this.#timeoutMs = positive(options.timeoutMs ?? 120_000, 15 * 60_000, 'timeout');
    this.#outputLimit = positive(options.outputLimitBytes ?? OUTPUT_LIMIT, 16 * 1024 * 1024, 'output');
    if (options.isolation !== undefined) {
      const isolation = options.isolation;
      if (!isolatedStores.has(isolation)) throw new Error('Podman isolation must come from fresh isolatedPodmanOptions');
      for (const key of ['storage', 'runroot', 'tmp', 'runtime', 'home']) checkedHostPath(isolation[key]);
      resourceToken(isolation.namespace);
      const locations = ['storage', 'runroot', 'tmp', 'runtime', 'home'].map((key) => isolation[key]);
      if (new Set(locations).size !== locations.length) throw new Error('Podman isolation paths must be distinct');
      // SQLite-backed Libpod rejects --namespace. Exclusive storage/runroot/runtime paths
      // isolate the engine; spec names and ownership labels enforce the resource namespace below.
      this.#namespace = isolation.namespace;
      this.#prefix = ['--root', isolation.storage, '--runroot', isolation.runroot, '--tmpdir', isolation.tmp, '--storage-driver', 'vfs'];
      this.#env = { ...this.#env, HOME: isolation.home, XDG_RUNTIME_DIR: isolation.runtime, TMPDIR: isolation.tmp };
      delete this.#env.DBUS_SESSION_BUS_ADDRESS;
    }
  }

  async #run(args, options = {}) {
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid Podman argument');
    validateInput(options.input);
    const result = await this.#executor.run('/usr/bin/podman', [...this.#prefix, ...args], {
      env: { ...this.#env }, timeoutMs: positive(options.timeoutMs ?? this.#timeoutMs, 15 * 60_000, 'timeout'),
      outputLimitBytes: this.#outputLimit, input: options.input, signal: options.signal,
    });
    if (!Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid Podman command result');
    let truncated = result.truncated ?? false;
    const cap = (text) => {
      const buffer = Buffer.from(text);
      if (buffer.length <= this.#outputLimit) return text;
      truncated = true;
      return buffer.subarray(buffer.length - this.#outputLimit).toString('utf8');
    };
    const bounded = { code: result.code, stdout: cap(result.stdout), stderr: cap(result.stderr), truncated };
    if (bounded.code !== 0 && !options.allowFailure) throw new Error(`Podman ${args[0]} failed (${bounded.code}): ${bounded.stderr.trim()}`);
    return bounded;
  }

  async info() {
    const result = await this.#run(['info', '--format', 'json']);
    if (result.truncated) throw new Error('Podman info output exceeded its bound');
    const info = JSON.parse(result.stdout);
    if (info.host?.security?.rootless !== true) throw new Error('Rootless Podman is required');
    return { version: info.version?.Version, rootless: true, graphRoot: info.store?.graphRoot, runRoot: info.store?.runRoot, cgroupManager: info.host?.cgroupManager };
  }

  async #exists(kind, name) {
    const result = await this.#run([kind, 'exists', name], { allowFailure: true });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`Podman ${kind} existence check failed (${result.code})`);
  }

  #assertScope(spec) {
    assertContainerSpec(spec);
    if (this.#namespace && spec.namespace !== this.#namespace) throw new Error('Container namespace differs from the isolated runtime');
  }

  #volumeFor(spec, component) {
    this.#assertScope(spec);
    return volumeFor(spec, component);
  }

  async inspect(spec) {
    this.#assertScope(spec);
    if (!await this.#exists('container', spec.name)) return null;
    const row = oneJson(await this.#run(['inspect', '--type', 'container', spec.name]));
    const host = row.HostConfig;
    const actualMounts = row.Mounts;
    const mountsMatch = Array.isArray(actualMounts) && actualMounts.length === spec.mounts.length && spec.mounts.every((mount) => {
      const matches = actualMounts.filter((entry) => entry.Destination === mount.target);
      return matches.length === 1 && matches[0].Type === mount.type && matches[0].RW === !mount.readOnly
        && (mount.type === 'volume' ? matches[0].Name : matches[0].Source) === mount.source;
    });
    const networkMatches = host?.NetworkMode === spec.network
      || (spec.network === 'slirp4netns:allow_host_loopback=false' && host?.NetworkMode === 'slirp4netns');
    const cpus = host?.NanoCpus > 0 ? host.NanoCpus / 1e9 : host?.CpuPeriod > 0 ? host.CpuQuota / host.CpuPeriod : 0;
    if (!/^[a-f0-9]{64}$/.test(row.Id) || row.Name?.replace(/^\//, '') !== spec.name
      || !labelsMatch(row.Config?.Labels, spec.labels) || row.ImageName !== spec.image || !mountsMatch || !networkMatches
      || (spec.legacy && (row.Id !== spec.legacy.containerId || String(row.Image).replace(/^sha256:/, '') !== spec.legacy.imageId.replace(/^sha256:/, '')
        || !legacyLabelsMatch(row.Config?.Labels, spec.resource.id)))
      || host.Privileged !== false || host.ReadonlyRootfs !== false
      || (host.CapAdd && host.CapAdd.length !== 0) || (host.Devices && host.Devices.length !== 0)
      || (host.SecurityOpt && host.SecurityOpt.length !== 0)
      || !['', 'private'].includes(host.PidMode) || !['', 'private'].includes(host.IpcMode)
      || (host.PortBindings && Object.keys(host.PortBindings).length > 0)
      || host.Memory !== spec.limits.memoryMb * 1024 * 1024 || host.MemorySwap !== host.Memory
      || host.PidsLimit !== spec.limits.pidsLimit || !Number.isFinite(cpus) || Math.abs(cpus - spec.limits.cpus) > 0.000001) {
      throw new Error('Container ownership or runtime specification mismatch');
    }
    if (!['configured', 'created', 'running', 'paused', 'stopped', 'exited', 'stopping'].includes(row.State?.Status)) throw new Error('Invalid container state');
    return { id: row.Id, state: row.State.Status };
  }

  async inspectBinding(spec) {
    return await this.#owned(spec);
  }

  async #owned(spec) {
    const container = await this.inspect(spec);
    if (!container) throw new Error('Container is missing');
    for (const volume of spec.volumes) await this.inspectVolume(spec, volume.component);
    if (spec.legacy) {
      for (const mount of spec.mounts.filter((entry) => entry.type === 'bind')) checkedHostPath(mount.source, { file: mount.target === '/workspace/.git' });
    }
    return container;
  }

  async create(spec) {
    this.#assertScope(spec);
    if (spec.legacy) throw new Error('Legacy bindings cannot create or recreate a container');
    const rootless = await this.#run(['info', '--format', '{{.Host.Security.Rootless}}']);
    if (rootless.stdout.trim() !== 'true') throw new Error('Rootless Podman is required');
    if (await this.#exists('container', spec.name)) throw new Error('Container already exists; lifecycle adoption must validate it');
    for (const volume of spec.volumes) await this.inspectVolume(spec, volume.component);
    for (const mount of spec.mounts.filter((entry) => entry.type === 'bind')) checkedHostPath(mount.source, { file: mount.target === '/workspace/.git' });
    if (spec.envFile) checkedHostPath(spec.envFile, { file: true });
    const args = ['create', '--name', spec.name];
    for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`);
    args.push('--cgroups=split', '--systemd=always', `--memory=${spec.limits.memoryMb}m`, `--memory-swap=${spec.limits.memoryMb}m`,
      `--cpus=${spec.limits.cpus}`, `--pids-limit=${spec.limits.pidsLimit}`, `--network=${spec.network}`, '--workdir=/workspace', '--env=HOME=/root');
    if (spec.envFile) args.push('--env-file', spec.envFile);
    for (const mount of spec.mounts) args.push('--mount', `type=${mount.type},src=${mount.source},dst=${mount.target}${mount.readOnly ? ',ro' : ''}`);
    args.push(spec.image);
    await this.#run(args);
    return await this.#owned(spec);
  }

  async start(spec) { const row = await this.#owned(spec); await this.#run(['start', row.id]); }
  async stop(spec, timeoutSeconds = 8) {
    positive(timeoutSeconds, 120, 'stop timeout');
    const row = await this.#owned(spec);
    await this.#run(['stop', '-t', String(timeoutSeconds), row.id]);
  }
  async remove(spec) {
    const row = await this.#owned(spec);
    if (!['created', 'configured', 'stopped', 'exited'].includes(row.state)) throw new Error('Stop the container before removal');
    await this.#run(['rm', row.id]);
  }
  async pause(spec) {
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    await this.#run(['pause', row.id]);
  }
  async unpause(spec) {
    const row = await this.#owned(spec);
    if (row.state !== 'paused') throw new Error('Container is not paused');
    await this.#run(['unpause', row.id]);
  }

  async inspectVolume(spec, component) {
    const volume = this.#volumeFor(spec, component);
    if (!await this.#exists('volume', volume.name)) throw new Error('Owned volume is missing');
    const row = oneJson(await this.#run(['volume', 'inspect', volume.name]));
    const storageMatches = spec.legacy
      ? row.Mountpoint === volume.path && row.Options != null && Object.keys(row.Options).length === 0 && legacyLabelsMatch(row.Labels, spec.resource.id)
      : row.Options?.type === 'none' && row.Options?.o === 'bind' && row.Options?.device === volume.path;
    if (row.Name !== volume.name || !labelsMatch(row.Labels, volumeLabels(spec, component)) || row.Driver !== 'local' || !storageMatches) throw new Error('Volume ownership or storage specification mismatch');
    if (spec.legacy) checkedHostPath(volume.path);
    return volume;
  }

  async ensureVolume(spec, component) {
    const volume = this.#volumeFor(spec, component);
    if (spec.legacy) return await this.inspectVolume(spec, component);
    checkedHostPath(volume.path);
    if (await this.#exists('volume', volume.name)) return await this.inspectVolume(spec, component);
    const args = ['volume', 'create'];
    for (const [key, value] of Object.entries(volumeLabels(spec, component))) args.push('--label', `${key}=${value}`);
    args.push('--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${volume.path}`, volume.name);
    await this.#run(args);
    return await this.inspectVolume(spec, component);
  }

  async exportVolume(spec, component, snapshotId) {
    const volume = await this.inspectVolume(spec, component);
    resourceToken(snapshotId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId));
    const output = join(directory, `${component}.tar`);
    try { lstatSync(output); throw new Error('Snapshot archive already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.#run(['volume', 'export', '--output', output, volume.name]);
  }

  /** Import only into an entirely new storage generation. A partial import is retained for the
   * lifecycle owner to inspect; this primitive never destroys the previous recoverable storage. */
  async importSnapshotVolume(sourceSpec, snapshotId, targetSpec, component) {
    resourceToken(snapshotId);
    this.#volumeFor(sourceSpec, component);
    const target = this.#volumeFor(targetSpec, component);
    if (targetSpec.legacy) throw new Error('A legacy binding cannot be a restore destination');
    if (sourceSpec.resource.kind !== targetSpec.resource.kind
      || (sourceSpec.resource.id === targetSpec.resource.id && sourceSpec.generation === targetSpec.generation)) throw new Error('Restore needs a new resource or generation');
    if (await this.#exists('container', targetSpec.name) || await this.#exists('volume', target.name)) throw new Error('Restore destination already exists');
    const archive = checkedHostPath(join(sourceSpec.storageRoot, 'snapshots', snapshotId, `${component}.tar`), { file: true });
    checkedHostPath(dirname(target.path), { create: true });
    mkdirSync(target.path, { mode: 0o700 });
    await this.ensureVolume(targetSpec, component);
    await this.#run(['volume', 'import', target.name, archive]);
  }

  async removeVolume(spec, component) {
    const volume = await this.inspectVolume(spec, component);
    await this.#run(['volume', 'rm', volume.name]);
    // Local-driver bind contents are intentionally retained for checkpointed lifecycle deletion.
  }

  async ensureProjectImage(dataDir) {
    const context = checkedHostPath(join(hostPath(dataDir), 'environment-base', PROJECT_BASE_IMAGE_TAG.split(':').at(-1)), { create: true });
    if (await this.#exists('image', PROJECT_BASE_IMAGE_TAG)) return PROJECT_BASE_IMAGE_TAG;
    const rootless = await this.#run(['info', '--format', '{{.Host.Security.Rootless}}']);
    if (rootless.stdout.trim() !== 'true') throw new Error('Rootless Podman is required');
    const file = join(context, 'Containerfile');
    try { writeFileSync(file, PROJECT_CONTAINERFILE, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      checkedHostPath(file, { file: true });
      if (readFileSync(file, 'utf8') !== PROJECT_CONTAINERFILE) throw new Error('Project base image context differs from the trusted recipe');
    }
    await this.#run(['build', '--tag', PROJECT_BASE_IMAGE_TAG, context], { timeoutMs: 15 * 60_000 });
    if (!await this.#exists('image', PROJECT_BASE_IMAGE_TAG)) throw new Error('Project base image build produced no image');
    return PROJECT_BASE_IMAGE_TAG;
  }

  async snapshotImage(spec, snapshotId) {
    const row = await this.#owned(spec);
    if (!['paused', 'stopped', 'exited', 'created'].includes(row.state)) throw new Error('Snapshot requires a quiesced container');
    const reference = snapshotReference(spec, snapshotId);
    if (await this.#exists('image', reference)) throw new Error('Snapshot image already exists');
    const args = ['commit', '--pause=false', '--change', `LABEL io.elowen.snapshot=${snapshotId}`, row.id, reference];
    await this.#run(args);
    return await this.inspectSnapshotImage(spec, snapshotId);
  }

  async inspectSnapshotImage(spec, snapshotId) {
    this.#assertScope(spec);
    const reference = snapshotReference(spec, snapshotId);
    const row = oneJson(await this.#run(['image', 'inspect', reference]));
    if (!labelsMatch(row.Labels ?? row.Config?.Labels, { ...spec.labels, 'io.elowen.snapshot': snapshotId }) || !/^(sha256:)?[a-f0-9]{64}$/.test(row.Id)) throw new Error('Snapshot image ownership mismatch');
    return row.Id;
  }

  async cancelExecution(spec, executionId) {
    const unit = executionUnit(spec, executionId);
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Guest termination cannot be verified in this container state');
    // The runtime mask is a tombstone: it blocks StartTransientUnit arriving after cancellation.
    // Keep it until the runtime generation ends, rather than reopening a late-launch race.
    await this.#run(['exec', row.id, 'systemctl', 'mask', '--runtime', unit]);
    const stop = await this.#run(['exec', row.id, 'systemctl', 'stop', unit], { allowFailure: true });
    const shown = await this.#run(['exec', row.id, 'systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit]);
    const fields = Object.fromEntries(shown.stdout.trim().split('\n').map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (shown.truncated || fields.LoadState !== 'masked' || !['inactive', 'failed'].includes(fields.ActiveState)
      || !['dead', 'failed'].includes(fields.SubState) || fields.ControlGroup !== '' || (stop.code !== 0 && stop.code !== 5)) {
      throw new Error('Guest execution termination could not be verified');
    }
    return { terminated: true, unit };
  }

  /** Only after the owning launcher has settled and the durable lease forbids redispatch. Timed-out
   * launchers keep their tombstone until daemon recovery establishes that fact or retires the runtime. */
  async releaseExecution(spec, executionId) {
    await this.cancelExecution(spec, executionId);
    const row = await this.#owned(spec);
    await this.#run(['exec', row.id, 'systemctl', 'unmask', '--runtime', executionUnit(spec, executionId)]);
  }

  /** Persist the host-generated executionId in the existing lease BEFORE calling. A timeout or aborted
   * Podman client is followed by guest-side cancellation; inability to verify it is an explicit failure. */
  async exec(spec, executionId, argv, options = {}) {
    const unit = executionUnit(spec, executionId);
    validateInput(options.input);
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
      || argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 64 * 1024 || !argv[0].startsWith('/')) throw new Error('Invalid guest command arguments');
    const workdir = options.workdir ?? '/workspace';
    if (typeof workdir !== 'string' || !workdir.startsWith('/') || /[\0\r\n]/.test(workdir) || workdir.length > 4096) throw new Error('Invalid guest working directory');
    const timeoutMs = positive(options.timeoutMs ?? 120_000, 15 * 60_000, 'timeout');
    options.signal?.throwIfAborted();
    const row = await this.#owned(spec);
    if (row.state !== 'running') throw new Error('Container is not running');
    let result;
    let failure;
    try {
      result = await this.#run(['exec', '--interactive', row.id, 'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`,
        '--service-type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=5s', `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}s`,
        `--working-directory=${workdir}`, '--', ...argv], { input: options.input, timeoutMs, signal: options.signal, allowFailure: true });
    } catch (error) { failure = error; }
    try {
      if (failure) await this.cancelExecution(spec, executionId);
      else await this.releaseExecution(spec, executionId);
    } catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], `Guest command cleanup failed: ${error.message}`); }
    if (failure) throw failure;
    return result;
  }
}
