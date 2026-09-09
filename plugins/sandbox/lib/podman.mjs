import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_BASE_IMAGE_TAG, PROJECT_CONTAINERFILE } from './containerBaseImage.mjs';
import { assertContainerSpec, executionUnit, hostPath, resourceToken, snapshotReference, volumeLabels, withContainerLimits, createLegacySiteSpec } from './containerSpec.mjs';
import { checkedHostPath } from './containerPaths.mjs';
import { COMPLETION_CWD_LIMIT, completionArtifact, completionPrelude, parseCompletionCwd } from './managedCompletion.mjs';

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

function validateUserSessionBus(expected = null) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Test user session bus requires a rootless account');
  const directory = checkedHostPath(`/run/user/${uid}`);
  const parent = lstatSync(directory);
  const path = `${directory}/bus`;
  const socket = lstatSync(path);
  if (parent.uid !== uid || (parent.mode & 0o022) !== 0 || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid) throw new Error('Untrusted user session bus');
  if (expected && (expected.uid !== uid || expected.path !== path || expected.dev !== socket.dev || expected.ino !== socket.ino)) throw new Error('The validated user session bus changed');
  return Object.freeze({ uid, path, dev: socket.dev, ino: socket.ino });
}

/** Optional integration harnesses must use this complete, private namespace, never account defaults.
 * The caller creates a fresh disposable parent with mkdtemp and retains responsibility for cleanup. */
export function isolatedPodmanOptions(directory, namespace, options = {}) {
  if (!options || Object.keys(options).some((key) => key !== 'useUserSessionBus')
    || (options.useUserSessionBus !== undefined && typeof options.useUserSessionBus !== 'boolean')) throw new Error('Invalid test isolation options');
  const userBus = options.useUserSessionBus ? validateUserSessionBus() : null;
  hostPath(directory);
  resourceToken(namespace);
  if (Buffer.byteLength(join(directory, 'runroot')) > 50) throw new Error('Isolated Podman runroot must fit within 50 bytes; use a short private temporary parent');
  checkedHostPath(dirname(directory));
  // Exclusive creation prevents attaching a test to an existing account store or another harness.
  mkdirSync(directory, { mode: 0o700 });
  const location = (part) => checkedHostPath(join(directory, part), { create: true });
  const isolation = Object.freeze({
    storage: location('storage'), runroot: location('runroot'), tmp: location('tmp'),
    runtime: location('runtime'), home: location('home'), namespace, userBus,
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
/** `systemctl show --property=…` output as a plain record; an absent property reads as undefined. */
function unitProperties(stdout) {
  return Object.fromEntries(String(stdout).trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
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
  #userBus;

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
      if (isolation.userBus) {
        this.#userBus = validateUserSessionBus(isolation.userBus);
        this.#env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${this.#userBus.path}`;
      } else delete this.#env.DBUS_SESSION_BUS_ADDRESS;
    }
  }

  async #run(args, options = {}) {
    if (this.#userBus) validateUserSessionBus(this.#userBus);
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

  /** The preflight both container creation and project image builds run. `info --format json` above
   *  answers the same question for a diagnostic read; this is the narrow probe on the write paths. */
  async #assertRootless() {
    const rootless = await this.#run(['info', '--format', '{{.Host.Security.Rootless}}']);
    if (rootless.stdout.trim() !== 'true') throw new Error('Rootless Podman is required');
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
    if (!/^[a-f0-9]{64}$/.test(row.Id) || (spec.expectedId && row.Id !== spec.expectedId) || row.Name?.replace(/^\//, '') !== spec.name
      || !labelsMatch(row.Config?.Labels, spec.labels) || row.ImageName !== spec.image || !mountsMatch || !networkMatches
      || (spec.legacy && (row.Id !== spec.legacy.containerId || String(row.Image).replace(/^sha256:/, '') !== spec.legacy.imageId.replace(/^sha256:/, '')
        || !legacyLabelsMatch(row.Config?.Labels, spec.resource.id)))
      || host.Privileged !== false || host.ReadonlyRootfs !== false
      || (host.CapAdd && host.CapAdd.length !== 0) || (host.Devices && host.Devices.length !== 0)
      || (host.SecurityOpt && host.SecurityOpt.length !== 0)
      || !['', 'private'].includes(host.PidMode) || host.IpcMode !== spec.ipcMode
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
    if (spec.expectedId) throw new Error('An immutable container binding cannot be recreated');
    await this.#assertRootless();
    if (await this.#exists('container', spec.name)) throw new Error('Container already exists; lifecycle adoption must validate it');
    for (const volume of spec.volumes) await this.inspectVolume(spec, volume.component);
    for (const mount of spec.mounts.filter((entry) => entry.type === 'bind')) checkedHostPath(mount.source, { file: mount.target === '/workspace/.git' });
    if (spec.envFile) checkedHostPath(spec.envFile, { file: true });
    const args = ['create', '--name', spec.name];
    for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`);
    args.push('--cgroups=split', '--systemd=always', `--ipc=${spec.ipcMode}`, `--memory=${spec.limits.memoryMb}m`, `--memory-swap=${spec.limits.memoryMb}m`,
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
    if (await this.#exists('container', spec.name)) throw new Error('Container removal was not verified');
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
    await this.#volumeArchive(volume, 'export', output);
  }

  /** Import only into an entirely new storage generation. A partial import is retained for the
   * lifecycle owner to inspect; this primitive never destroys the previous recoverable storage. */
  async importSnapshotVolume(sourceSpec, snapshotId, targetSpec, component, { resume = false } = {}) {
    resourceToken(snapshotId);
    this.#volumeFor(sourceSpec, component);
    const target = this.#volumeFor(targetSpec, component);
    if (targetSpec.legacy) throw new Error('A legacy binding cannot be a restore destination');
    if (sourceSpec.resource.kind !== targetSpec.resource.kind
      || (sourceSpec.resource.id === targetSpec.resource.id && sourceSpec.generation === targetSpec.generation)) throw new Error('Restore needs a new resource or generation');
    if (await this.#exists('container', targetSpec.name)) throw new Error('Restore destination already exists');
    if (await this.#exists('volume', target.name)) {
      if (!resume) throw new Error('Restore destination already exists');
      await this.removeVolume(targetSpec, component);
    }
    if (resume) {
      try {
        checkedHostPath(target.path);
        await this.#run(['unshare', '/usr/bin/rm', '-rf', '--', target.path], { timeoutMs: 120000 });
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    const archive = checkedHostPath(join(sourceSpec.storageRoot, 'snapshots', snapshotId, `${component}.tar`), { file: true });
    checkedHostPath(dirname(target.path), { create: true });
    mkdirSync(target.path, { mode: 0o700 });
    await this.ensureVolume(targetSpec, component);
    await this.#volumeArchive(target, 'import', archive);
  }

  async #volumeArchive(volume, operation, archive) {
    if (!['import', 'export'].includes(operation)) throw new Error('Invalid volume archive operation');
    // Local-bind volumes must be mounted in the rootless mount namespace. Keep mount, archive I/O
    // and balanced unmount in ONE unshare process; only Podman extracts the guest archive.
    const script = 'set -eu\noperation=$1; volume=$2; archive=$3; shift 3\nengine=("$@")\n"${engine[@]}" volume mount "$volume" >/dev/null\ntrap \'status=$?; trap - EXIT; "${engine[@]}" volume unmount "$volume" >/dev/null || exit 125; exit "$status"\' EXIT\nif [ "$operation" = import ]; then "${engine[@]}" volume import "$volume" "$archive"; else "${engine[@]}" volume export --output "$archive" "$volume"; fi\n';
    await this.#run(['unshare', '/bin/bash', '-c', script, 'elowen-volume-archive', operation, volume.name, archive, '/usr/bin/podman', ...this.#prefix], { timeoutMs: 120000 });
  }

  async removeVolume(spec, component) {
    const target = this.#volumeFor(spec, component);
    if (!await this.#exists('volume', target.name)) return;
    const volume = await this.inspectVolume(spec, component);
    await this.#run(['volume', 'rm', volume.name]);
    if (await this.#exists('volume', volume.name)) throw new Error('Volume removal was not verified');
  }

  async update(spec, requested) {
    const next = withContainerLimits(spec, requested);
    let row;
    try { row = await this.#owned(spec); }
    catch (cause) {
      // Recover a completed engine update whose durable acknowledgement was interrupted.
      try { await this.#owned(next); return next; } catch { throw cause; }
    }
    await this.#run(['update', `--memory=${next.limits.memoryMb}m`, `--memory-swap=${next.limits.memoryMb}m`, `--cpus=${next.limits.cpus}`, `--pids-limit=${next.limits.pidsLimit}`, row.id]);
    await this.#owned(next);
    return next;
  }

  async discardIncompleteSnapshot(spec, snapshotId) {
    this.#assertScope(spec); resourceToken(snapshotId);
    const directory = checkedHostPath(join(spec.storageRoot, 'snapshots', snapshotId));
    const pending = checkedHostPath(join(directory, 'pending.json'), { file: true });
    const record = JSON.parse(readFileSync(pending, 'utf8'));
    if (record.snapshotId !== snapshotId || record.resource?.kind !== spec.resource.kind || record.resource?.id !== spec.resource.id || record.generation !== spec.generation || record.specHash !== spec.specHash) throw new Error('Incomplete snapshot ownership mismatch');
    try { lstatSync(join(directory, 'manifest.json')); throw new Error('A completed snapshot cannot be discarded as incomplete'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await this.removeSnapshotImage(spec, snapshotId);
    await this.#run(['unshare', '/usr/bin/rm', '-rf', '--', directory]);
  }

  async removeSnapshotStorage(spec, snapshotId) {
    this.#assertScope(spec); resourceToken(snapshotId);
    const directory = join(spec.storageRoot, 'snapshots', snapshotId);
    try { checkedHostPath(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    const file = checkedHostPath(join(directory, 'manifest.json'), { file: true });
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.snapshotId !== snapshotId || manifest.resource?.kind !== spec.resource.kind || manifest.resource?.id !== spec.resource.id || manifest.generation !== spec.generation || manifest.specHash !== spec.specHash) throw new Error('Snapshot cleanup ownership mismatch');
    await this.#run(['unshare', '/usr/bin/rm', '-rf', '--', directory]);
    try { lstatSync(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    throw new Error('Snapshot cleanup was not verified');
  }

  async removeSnapshotImage(spec, snapshotId) {
    const reference = snapshotReference(spec, snapshotId);
    if (!await this.#exists('image', reference)) return;
    const id = await this.inspectSnapshotImage(spec, snapshotId);
    await this.#run(['image', 'rm', id]);
    if (await this.#exists('image', reference)) throw new Error('Snapshot image removal was not verified');
  }

  async removeStorage(spec) {
    this.#assertScope(spec);
    if (await this.#exists('container', spec.name)) throw new Error('Container still owns environment storage');
    for (const volume of spec.volumes) if (await this.#exists('volume', volume.name)) throw new Error('A volume still owns environment storage');
    try { checkedHostPath(spec.storageRoot); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    // The path is derived from the immutable resource record. Only unshare can remove subordinate-UID
    // contents; rm does not follow guest-created symlinks and this root never names the Site source.
    await this.#run(['unshare', '/usr/bin/rm', '-rf', '--', spec.storageRoot], { timeoutMs: 120000 });
    try { lstatSync(spec.storageRoot); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    throw new Error('Environment storage removal was not verified');
  }

  async discoverLegacySite(input, binding) {
    if (input.resource.kind !== 'site') throw new Error('Site identity is required');
    resourceToken(input.resource.id);
    const name = `elowen-site-${input.resource.id}`;
    if (!await this.#exists('container', name)) return null;
    const container = oneJson(await this.#run(['inspect', name]));
    const volume = oneJson(await this.#run(['volume', 'inspect', `${name}-data`]));
    const pins = { containerId: container.Id, imageId: container.Image, volumeMountpoint: volume.Mountpoint };
    const spec = createLegacySiteSpec(input, { ...binding, ...pins });
    const verified = await this.#owned(spec);
    return { ...pins, state: verified.state === 'running' ? 'running' : verified.state === 'paused' ? 'paused' : 'stopped' };
  }

  async ensureSiteImage(dataDir, recipe) {
    if (!recipe || typeof recipe.tag !== 'string' || !/^localhost\/[a-z0-9][a-zA-Z0-9._/:-]{1,240}$/.test(recipe.tag)
      || !recipe.files || typeof recipe.files.Containerfile !== 'string') throw new Error('A fixed Sites image recipe is required');
    const files = Object.entries(recipe.files).sort(([a], [b]) => a.localeCompare(b));
    if (files.length > 32 || files.some(([name, content]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(name) || typeof content !== 'string')
      || files.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0) > 4 * 1024 * 1024) throw new Error('Invalid Sites image recipe files');
    const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const context = checkedHostPath(join(hostPath(dataDir), 'site-image-recipes', hash), { create: true });
    for (const [name, content] of files) {
      const path = join(context, name);
      try { writeFileSync(path, content, { flag: 'wx', mode: 0o600 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; checkedHostPath(path, { file: true }); if (readFileSync(path, 'utf8') !== content) throw new Error('Sites image recipe changed'); }
    }
    if (!await this.#exists('image', recipe.tag)) await this.#run(['build', '--tag', recipe.tag, context], { timeoutMs: 900000 });
    if (!await this.#exists('image', recipe.tag)) throw new Error('Sites image provisioning was not verified');
    return recipe.tag;
  }

  async imageStatus(reference) {
    if (typeof reference !== 'string' || !/^localhost\/[a-z0-9][a-zA-Z0-9._/:-]{1,240}$/.test(reference)) throw new Error('A fixed local Sites image reference is required');
    if (!await this.#exists('image', reference)) return { present: false, imageId: null };
    const row = oneJson(await this.#run(['image', 'inspect', reference]));
    if (!/^(sha256:)?[a-f0-9]{64}$/.test(row.Id)) throw new Error('Invalid image identity');
    return { present: true, imageId: row.Id };
  }

  async discoverRetainedSiteImage(spec, reference) {
    this.#assertScope(spec);
    if (spec.resource.kind !== 'site' || typeof reference !== 'string' || !/^[a-z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(reference)) throw new Error('Invalid retained Sites image reference');
    const row = oneJson(await this.#run(['image', 'inspect', reference]));
    if (!/^(sha256:)?[a-f0-9]{64}$/.test(row.Id) || !labelsMatch(row.Labels ?? row.Config?.Labels, { 'io.elowen.site': spec.resource.id })) throw new Error('Retained Sites image ownership mismatch');
    return row.Id;
  }

  async removeOrphanLegacySiteData(spec) {
    this.#assertScope(spec);
    if (spec.resource.kind !== 'site') throw new Error('Sites lifecycle authority is required');
    const name = `elowen-site-${spec.resource.id}`;
    if (await this.#exists('container', name)) throw new Error('An unretired legacy Sites container still exists');
    const volumeName = `${name}-data`;
    if (!await this.#exists('volume', volumeName)) return;
    const volume = oneJson(await this.#run(['volume', 'inspect', volumeName]));
    if (volume.Name !== volumeName || volume.Driver !== 'local' || !volume.Options || Object.keys(volume.Options).length || !legacyLabelsMatch(volume.Labels, spec.resource.id)) throw new Error('Orphan legacy volume ownership mismatch');
    checkedHostPath(volume.Mountpoint);
    await this.#run(['volume', 'rm', volumeName]);
    if (await this.#exists('volume', volumeName)) throw new Error('Legacy volume cleanup was not verified');
  }

  async inspectRetainedSiteImage(spec, reference, imageId) {
    this.#assertScope(spec);
    if (spec.resource.kind !== 'site' || typeof reference !== 'string' || !/^[a-z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(reference)
      || !/^(sha256:)?[a-f0-9]{64}$/.test(imageId)) throw new Error('Invalid retained Sites image binding');
    const row = oneJson(await this.#run(['image', 'inspect', reference]));
    if (String(row.Id).replace(/^sha256:/, '') !== imageId.replace(/^sha256:/, '') || !labelsMatch(row.Labels ?? row.Config?.Labels, { 'io.elowen.site': spec.resource.id })) throw new Error('Retained Sites image ownership mismatch');
    return row.Id;
  }

  async removeRetainedSiteImage(spec, reference, imageId) {
    this.#assertScope(spec);
    if (!await this.#exists('image', reference)) return;
    await this.inspectRetainedSiteImage(spec, reference, imageId);
    // Remove the retained reference, not every alias of an image shared by another release.
    await this.#run(['image', 'rm', reference]);
    if (await this.#exists('image', reference)) throw new Error('Retained image removal was not verified');
  }

  async siteDataArchive(spec, operation, archivePath) {
    this.#assertScope(spec);
    if (spec.resource.kind !== 'site') throw new Error('Sites data authority is required');
    const current = await this.inspect(spec);
    if (operation === 'import' && current && !['created', 'configured', 'stopped', 'exited'].includes(current.state)) throw new Error('Stop the staging container before importing data');
    const volume = await this.inspectVolume(spec, 'data');
    const archive = hostPath(archivePath);
    if (operation === 'import') checkedHostPath(archive, { file: true });
    else {
      checkedHostPath(dirname(archive), { create: true });
      try { lstatSync(archive); throw new Error('Archive destination already exists'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    await this.#volumeArchive(volume, operation, archive);
  }

  async removeGenerationStorage(spec) {
    this.#assertScope(spec);
    if (spec.legacy) throw new Error('Legacy storage cannot be staging storage');
    if (await this.inspect(spec)) throw new Error('Remove the staging container before its storage');
    for (const volume of spec.volumes) if (await this.#exists('volume', volume.name)) throw new Error('A volume still owns staging storage');
    const directory = join(spec.storageRoot, 'storage', String(spec.generation));
    try { checkedHostPath(directory); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    await this.#run(['unshare', '/usr/bin/rm', '-rf', '--', directory]);
  }

  async ensureProjectImage(dataDir) {
    const context = checkedHostPath(join(hostPath(dataDir), 'environment-base', PROJECT_BASE_IMAGE_TAG.split(':').at(-1)), { create: true });
    if (await this.#exists('image', PROJECT_BASE_IMAGE_TAG)) return PROJECT_BASE_IMAGE_TAG;
    await this.#assertRootless();
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

  async cancelExecution(spec, executionId, { persistent = false } = {}) {
    return await this.#tombstone(spec, executionId, await this.#owned(spec), persistent);
  }

  /** The termination tombstone, against a container row this call stack has already verified. */
  async #tombstone(spec, executionId, row, persistent) {
    const unit = executionUnit(spec, executionId);
    if (row.state !== 'running') throw new Error('Guest termination cannot be verified in this container state');
    // The runtime mask is a tombstone: it blocks StartTransientUnit arriving after cancellation.
    // Keep it until the runtime generation ends, rather than reopening a late-launch race.
    await this.#run(['exec', row.id, 'systemctl', 'mask', ...(persistent ? [] : ['--runtime']), unit]);
    const stop = await this.#run(['exec', row.id, 'systemctl', 'stop', unit], { allowFailure: true });
    // Collecting a transient unit after stop invalidates its loaded mask state. Re-establish the
    // tombstone after collection and verify it; not-found alone is not proof against late starts.
    await this.#run(['exec', row.id, 'systemctl', 'mask', ...(persistent ? [] : ['--runtime']), unit]);
    const shown = await this.#run(['exec', row.id, 'systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit]);
    const fields = unitProperties(shown.stdout);
    if (shown.truncated || fields.LoadState !== 'masked' || !['inactive', 'failed'].includes(fields.ActiveState)
      || !['dead', 'failed'].includes(fields.SubState) || fields.ControlGroup !== '' || (stop.code !== 0 && stop.code !== 5)) {
      throw new Error('Guest execution termination could not be verified');
    }
    // The completion artifact is derived from the execution ID, so removal can never touch another
    // execution's state. Best effort only: a leftover is benign tmpfs state scoped to this container.
    await this.#run(['exec', row.id, '/usr/bin/rm', '-f', '--', completionArtifact(executionId)], { allowFailure: true, timeoutMs: 30000 });
    // `container` is the ownership-verified row this cancellation ran against. Returning it lets an
    // immediately following step in the SAME call reuse the verification instead of repeating it; it is
    // not a cache, and nothing outside one call stack may hold it.
    return { terminated: true, unit, container: row };
  }

  /** Only after the owning launcher has settled and the durable lease forbids redispatch. Timed-out
   * launchers keep their tombstone until daemon recovery establishes that fact or retires the runtime. */
  async releaseExecution(spec, executionId, { persistent = false } = {}) {
    // The cancellation below verifies ownership and running state, and the only guest work between it
    // and the unmask is this method's own. Re-inspecting the container and every volume a second time
    // here cost five extra Podman invocations per guest operation and could not observe anything the
    // cancellation had not just established.
    const row = await this.#owned(spec);
    const unit = executionUnit(spec, executionId);
    if (row.state === 'running') {
      // A launcher that settled normally leaves nothing to terminate: `--collect` retires the transient
      // unit as it deactivates, and the mask tombstone only closes a late-StartTransientUnit race that
      // stays open while a unit is still loaded. Establishing that absence costs one guest round trip
      // where masking, stopping, re-masking, verifying and unmasking cost six, which was the dominant
      // term in a managed Git read: five subcommands paid it five times over. Proven absence is the only
      // thing that takes this path, so every other outcome, including a masked tombstone left by an
      // earlier cancellation, still runs the full termination below.
      const shown = await this.#run(['exec', row.id, 'systemctl', 'show', '--property=LoadState,ActiveState,SubState,ControlGroup', unit], { allowFailure: true });
      const fields = unitProperties(shown.stdout);
      if (!shown.truncated && shown.code === 0 && fields.LoadState === 'not-found'
        && fields.ActiveState === 'inactive' && fields.SubState === 'dead' && fields.ControlGroup === '') {
        await this.#run(['exec', row.id, '/usr/bin/rm', '-f', '--', completionArtifact(executionId)], { allowFailure: true, timeoutMs: 30000 });
        return;
      }
    }
    const { container } = await this.#tombstone(spec, executionId, row, persistent);
    await this.#run(['exec', container.id, 'systemctl', 'unmask', ...(persistent ? [] : ['--runtime']), unit]);
  }

  /** Persist the host-generated executionId in the existing lease BEFORE calling. A timeout or aborted
   * Podman client is followed by guest-side cancellation; inability to verify it is an explicit failure. */
  async #prepareGuest(spec, executionId, argv, options = {}) {
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
    // TasksMax=infinity defers to the container's own pids cgroup, which is the limit the environment
    // actually declares. The guest systemd otherwise caps every transient unit at DefaultTasksMax, 15%
    // of that budget, so a 512-PID environment let an execution reach only ~76 tasks: headless Chromium
    // peaks near 155 threads and died on pthread_create while the container was 84% idle. The bound is
    // not weakened, it is moved back to the one place that states it.
    return { timeoutMs, args: ['exec', '--interactive', row.id, 'systemd-run', '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`,
      '--service-type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=5s', '--property=TasksMax=infinity',
      `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}s`, `--working-directory=${workdir}`, '--', ...argv] };
  }

  async startPreview(spec, executionId, argv) {
    if (spec.resource.kind !== 'project' || !spec.mounts.some((mount) => mount.target === '/run/elowen')) throw new Error('Project preview transport is unavailable');
    const prepared = await this.#prepareGuest(spec, executionId, argv);
    const args = prepared.args.filter((arg) => !['--pipe', '--wait'].includes(arg) && !arg.startsWith('--property=RuntimeMaxSec='));
    await this.#run(args);
    const row = await this.#owned(spec);
    const shown = await this.#run(['exec', row.id, 'systemctl', 'is-active', executionUnit(spec, executionId)]);
    if (shown.stdout.trim() !== 'active') throw new Error('Preview service did not start');
  }

  /** Arms completion cwd capture for a canonical managed user shell execution. The returned `stdin`
   * is the capture prelude composed ahead of the caller's script: the guest shell records its final
   * physical working directory into a dedicated execution-owned artifact instead of an fd3 trap,
   * which cannot survive the podman/systemd transport. `completion.artifact` is internal transport
   * for the runtime's completionMetadata callback; consumers never see it. */
  async prepareExecution(spec, executionId, argv, options = {}) {
    if (options.completionCwd !== undefined && typeof options.completionCwd !== 'boolean') throw new Error('Invalid completion cwd option');
    const capture = options.completionCwd === true;
    const prepared = await this.#prepareGuest(spec, executionId, argv, options);
    let { input } = options;
    if (capture) {
      // Only the canonical managed shell consumes the user script from stdin, so only it can host the
      // EXIT trap. Anything else is refused instead of silently reporting a pretended cwd.
      if (argv.length !== 2 || argv[0] !== '/bin/bash' || argv[1] !== '-s') throw new Error('Completion cwd capture requires the canonical managed shell');
      const prelude = completionPrelude(executionId);
      input = Buffer.isBuffer(input) ? Buffer.concat([Buffer.from(prelude), input]) : input == null ? prelude : prelude + input;
    }
    if (this.#userBus) validateUserSessionBus(this.#userBus);
    return {
      launch: { type: 'argv', file: '/usr/bin/podman', args: [...this.#prefix, ...prepared.args], env: { ...this.#env } },
      stdin: input,
      ...(capture ? { completion: { artifact: completionArtifact(executionId) } } : {}),
    };
  }

  /** Resolves the captured final physical cwd of a canonical prepared execution. Call only AFTER the
   * guest process has exited and BEFORE lease release: cancel/release remove the artifact. The read
   * is guest resolution inside the same ownership-validated, immutable container — stat bounds the
   * artifact, then it is read whole; user stdout is never parsed. Returns `{ cwd: null }` for a
   * genuinely unavailable artifact (never created, already cleaned up, container not running, or
   * invalid content); ownership mismatches still throw. */
  async readCompletionCwd(spec, executionId) {
    const artifact = completionArtifact(executionId);
    const row = await this.inspect(spec);
    if (!row || row.state !== 'running') return { cwd: null };
    const stat = await this.#run(['exec', row.id, '/usr/bin/stat', '-c', '%F %s', '--', artifact], { allowFailure: true, timeoutMs: 30000 });
    if (stat.code !== 0) {
      if (stat.code === 1) return { cwd: null };
      throw new Error(`Completion artifact inspection failed (${stat.code})`);
    }
    const fields = stat.stdout.trim().split(' ');
    const size = Number(fields.pop());
    if (fields.join(' ') !== 'regular file' || !Number.isSafeInteger(size) || size < 1 || size > COMPLETION_CWD_LIMIT) return { cwd: null };
    const read = await this.#run(['exec', row.id, '/bin/cat', '--', artifact], { allowFailure: true, timeoutMs: 30000 });
    if (read.code !== 0) {
      if (read.code === 1) return { cwd: null };
      throw new Error(`Completion artifact read failed (${read.code})`);
    }
    return { cwd: parseCompletionCwd(read.stdout, { truncated: read.truncated }) };
  }

  async exec(spec, executionId, argv, options = {}) {
    const prepared = await this.#prepareGuest(spec, executionId, argv, options);
    let result;
    let failure;
    try {
      result = await this.#run(prepared.args, { input: options.input, timeoutMs: prepared.timeoutMs, signal: options.signal, allowFailure: true });
    } catch (error) { failure = error; }
    try {
      if (failure) await this.cancelExecution(spec, executionId, { persistent: options.persistent === true });
      else await this.releaseExecution(spec, executionId, { persistent: options.persistent === true });
    } catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], `Guest command cleanup failed: ${error.message}`); }
    if (failure) throw failure;
    return result;
  }
}
