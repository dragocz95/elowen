import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

const trustedSpecs = new WeakSet();
const DEFAULT_CONTAINER_LIMITS = Object.freeze({ cpus: 1, memoryMb: 1024, pidsLimit: 512 });

export function resourceToken(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('Invalid resource token');
  return value;
}

export function hostPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || normalize(value) !== value || /[\0\r\n,:]/.test(value)) {
    throw new Error('Invalid trusted host path');
  }
  return value;
}

/** Reserved single-segment guest directories a project mount may never take over. The mount point is
 * host-derived (the project's own slug), so this guards against a slug that happens to name part of the
 * base image, not against a hostile caller. Mirrors core's `RESERVED_GUEST_ROOTS`
 * (src/shared/projectExecution.ts), which refuses such a slug at project creation;
 * `tests/plugins/managedGuestRoot.test.ts` holds the two lists in step. */
export const RESERVED_GUEST_ROOTS = new Set(['bin', 'boot', 'data', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'workspace', 'worktrees']);

/** The guest directory a managed project is mounted at: one top-level directory named after the
 * project, so every path the agent sees starts with the project's own name. */
export function guestMountTarget(value) {
  if (typeof value !== 'string' || !/^\/[a-z0-9][a-z0-9-]{0,63}$/.test(value) || RESERVED_GUEST_ROOTS.has(value.slice(1))) {
    throw new Error('Invalid project mount target');
  }
  return value;
}

function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid container specification');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown container specification field: ${key}`);
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** The host supplies roots, never a guest tool. Persist resource identity and regenerate this spec from
 * authorized host records; a deserialized or caller-authored mount list is not an execution capability. */
export function createContainerSpec(input, paths) {
  return buildSpec(input, paths);
}

/** Create the complete persisted disk record for a new managed Project environment. A stored specification
 * without it is refused by `selectRuntimeClient` rather than adopted.
 *
 * `componentGeneration` names an environment whose workspace, HOME and data directories are already
 * durable and named after the generation that created them, so its disk record points at those paths
 * instead of copying the trees into the disk directory. */
export function createEnvironmentDiskSpec({ resource, image, runtime }, paths, diskId, componentGeneration) {
  closed(resource, ['kind', 'id']);
  if (runtime !== undefined && runtime !== 'nspawn') throw new Error('Invalid environment disk runtime');
  const { kind, id } = resource;
  if (kind !== 'project') throw new Error('Invalid container resource kind');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid project ID');
  if (typeof image !== 'string' || !/^[a-z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image)) throw new Error('Invalid container image');
  resourceToken(diskId);
  const storageRoot = join(hostPath(paths.sandboxDataDir), 'projects', String(id));
  const directory = join(storageRoot, 'disks', diskId);
  if (componentGeneration !== undefined && (!Number.isSafeInteger(componentGeneration) || componentGeneration < 1)) throw new Error('Invalid migrated disk component generation');
  const root = componentGeneration === undefined ? directory : join(storageRoot, 'storage', String(componentGeneration));
  const components = ['workspace', 'home', 'data'].map((component) => ({ component, path: join(root, component) }));
  // `runtime` is data on the disk record and the only driver discriminator. It is appended LAST and omitted
  // when absent, so the serialization of every disk already created stays byte-identical and their
  // specification hashes do not move.
  return freeze({ id: diskId, format: 2, rootfsPath: join(directory, 'rootfs'), components, sourceImage: image,
    ...(componentGeneration === undefined ? {} : { componentGeneration }), ...(runtime === undefined ? {} : { runtime }) });
}

/** Keep creation ownership stable while carrying the effective cgroup settings. A live limit change is
 * applied to the running envelope without rewriting the settings it was created with, so the creation
 * values remain part of its identity while `limits` records what the runtime has actually applied. */
export function withContainerLimits(spec, requested) {
  assertContainerSpec(spec);
  closed(requested, ['cpus', 'memoryMb', 'pidsLimit']);
  const limits = { cpus: requested.cpus, memoryMb: requested.memoryMb, pidsLimit: requested.pidsLimit };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 1024 || !Number.isSafeInteger(limits.cpus * 1e6)) throw new Error('Invalid CPU limit');
  for (const key of ['memoryMb', 'pidsLimit']) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 2 ** 30) throw new Error(`Invalid ${key} limit`);
  const next = { ...spec, creationLimits: spec.creationLimits ?? spec.limits, limits,
    specHash: createHash('sha256').update(JSON.stringify({ creation: spec.labels['io.elowen.spec'] ?? spec.specHash, limits })).digest('hex') };
  freeze(next); trustedSpecs.add(next); return next;
}

/** The complete SIMPLE network policy. Legacy string values remain readable so an existing environment's
 * identity stays byte-for-byte stable until an administrator explicitly changes its network policy. */
export function normalizeEnvironmentNetwork(value) {
  if (value === undefined || value === 'shared') return { mode: 'shared', inboundPorts: [] };
  if (value === 'isolated') return { mode: 'isolated', inboundPorts: [] };
  closed(value, ['mode', 'inboundPorts']);
  if (value.mode !== 'shared' && value.mode !== 'isolated') throw new Error('Invalid container network mode');
  if (!Array.isArray(value.inboundPorts) || value.inboundPorts.length > 32) throw new Error('Invalid container inbound ports');
  const seen = new Set();
  const inboundPorts = value.inboundPorts.map((entry) => {
    closed(entry, ['protocol', 'hostPort', 'guestPort']);
    if (entry.protocol !== 'tcp' && entry.protocol !== 'udp') throw new Error('Invalid container inbound port protocol');
    if (!Number.isSafeInteger(entry.hostPort) || entry.hostPort < 1024 || entry.hostPort > 65535
      || !Number.isSafeInteger(entry.guestPort) || entry.guestPort < 1 || entry.guestPort > 65535) throw new Error('Invalid container inbound port');
    const key = `${entry.protocol}:${entry.hostPort}`;
    if (seen.has(key)) throw new Error('Duplicate container inbound host port');
    seen.add(key);
    return { protocol: entry.protocol, hostPort: entry.hostPort, guestPort: entry.guestPort };
  }).sort((a, b) => a.protocol.localeCompare(b.protocol) || a.hostPort - b.hostPort || a.guestPort - b.guestPort);
  if (value.mode === 'isolated' && inboundPorts.length) throw new Error('An isolated container cannot publish inbound ports');
  return { mode: value.mode, inboundPorts };
}

function buildSpec(input, paths) {
  closed(input, ['resource', 'generation', 'image', 'limits', 'network', 'previewBroker', 'workspaceTarget', 'disk']);
  if (input.previewBroker !== undefined && typeof input.previewBroker !== 'boolean') throw new Error('Invalid preview broker policy');
  closed(input.resource, ['kind', 'id']);
  const { kind, id } = input.resource;
  if (kind !== 'project') throw new Error('Invalid container resource kind');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid project ID');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid runtime generation');
  if (typeof input.image !== 'string' || !/^[a-z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(input.image)) throw new Error('Invalid container image');
  const legacyNetwork = input.network === undefined || typeof input.network === 'string';
  const network = normalizeEnvironmentNetwork(input.network);
  closed(input.limits ?? {}, ['cpus', 'memoryMb', 'pidsLimit']);
  // An envelope keeps the limits it was created with until an explicit limits action updates them
  // through `withContainerLimits`, which is the only path that also applies them to the live machine.
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...input.limits };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 1024 || !Number.isSafeInteger(limits.cpus * 1e6)) throw new Error('Invalid CPU limit');
  for (const key of ['memoryMb', 'pidsLimit']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 2 ** 30) throw new Error(`Invalid ${key} limit`);
  }
  const namespace = resourceToken(paths.namespace ?? 'elowen');
  const resource = { kind, id };
  const generation = input.generation;
  const name = `${namespace}-${kind}-${id}-g${generation}`;
  const storageRoot = join(hostPath(paths.sandboxDataDir), 'projects', String(id));
  const components = ['workspace', 'home', 'data'];
  let disk;
  if (input.disk !== undefined) {
    closed(input.disk, ['id', 'format', 'rootfsPath', 'components', 'sourceImage', 'componentGeneration', 'runtime']);
    resourceToken(input.disk.id);
    if (input.disk.format !== 2 || !Array.isArray(input.disk.components)) throw new Error('Invalid environment disk specification');
    const expected = createEnvironmentDiskSpec({ resource, image: input.disk.sourceImage, runtime: input.disk.runtime }, paths, input.disk.id, input.disk.componentGeneration);
    if (input.disk.rootfsPath !== expected.rootfsPath || JSON.stringify(input.disk.components) !== JSON.stringify(expected.components)) throw new Error('Environment disk paths differ from their trusted resource root');
    disk = expected;
  }
  const volumes = components.map((component) => ({
    component, name: `${name}-${component}`, path: disk?.components.find((entry) => entry.component === component)?.path ?? join(storageRoot, 'storage', String(generation), component),
  }));
  const workdir = guestMountTarget(input.workspaceTarget);
  // A disk-backed environment binds the disk's own directories, so the disk record stays the single owner
  // of those paths and nothing outlives the generation that created it. The `volume` shape below belongs to
  // rows this release refuses to drive at all and is kept only so their stored specification still
  // deserializes into the identity that refusal reports.
  const mountFor = (target) => {
    const volume = volumes.find((entry) => entry.component === target);
    return disk ? { type: 'bind', source: volume.path } : { type: 'volume', source: volume.name };
  };
  const mounts = volumes.map((volume) => ({ ...mountFor(volume.component), target: { workspace: workdir, home: '/root', data: '/data' }[volume.component], readOnly: false }));
  if (input.previewBroker) mounts.push({ type: 'bind', source: join(storageRoot, 'broker'), target: '/run/elowen', readOnly: false });
  const settings = {
    resource, generation, namespace, name, image: input.image, limits, ...(disk ? { disk } : {}),
    workdir,
    ipcMode: 'private',
    network: network.mode === 'isolated' ? 'none' : 'slirp4netns:allow_host_loopback=false',
    ...(legacyNetwork ? {} : { inboundPorts: network.inboundPorts }),
    storageRoot, volumes, mounts,
    // Retained in the project specification because it has always been part of the hash preimage as null.
    envFile: null,
  };
  // The hash preimage keeps the `legacy: null` key every spec carried while older containers could still be
  // adopted. It is the identity in the `io.elowen.spec` label of every existing project environment, so
  // dropping it or the null `envFile` above would make each of them fail ownership. `workdir` remains excluded;
  // the project mount target changes the hash through its mount entry.
  const preimage = { resource, generation, namespace, name, image: input.image, limits, legacy: null, ...settings, workdir: undefined };
  const hash = createHash('sha256').update(JSON.stringify(preimage)).digest('hex');
  /** @type {Record<string, string>} */
  const labels = {
    'io.elowen.runtime': 'sandbox', 'io.elowen.namespace': namespace,
    'io.elowen.resource': `${kind}:${id}`, 'io.elowen.generation': String(generation), 'io.elowen.spec': hash,
    ...(disk ? { 'io.elowen.disk': disk.id } : {}),
  };
  const spec = { ...settings, specHash: hash, labels };
  freeze(spec);
  trustedSpecs.add(spec);
  return spec;
}

export function bindContainerIdentity(spec, containerId) {
  assertContainerSpec(spec);
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid immutable container identity');
  const bound = { ...spec, expectedId: containerId };
  freeze(bound); trustedSpecs.add(bound); return bound;
}

export function assertContainerSpec(spec) {
  if (!trustedSpecs.has(spec)) throw new Error('A trusted host-derived container specification is required');
  return spec;
}

export function executionUnit(spec, executionId) {
  assertContainerSpec(spec);
  if (typeof executionId !== 'string' || !/^[a-f0-9]{32}$/.test(executionId)) throw new Error('Invalid host execution ID');
  return `elowen-exec-g${spec.generation}-${executionId}.service`;
}

/** The bounded runtime identity for a publication. The durable database row keeps the complete id; host
 * sockets and guest units use only this stable digest so UUIDs remain safe inside their tighter limits. */
export function publicationRuntimeToken(publicationId) {
  resourceToken(publicationId);
  return createHash('sha256').update(publicationId).digest('hex').slice(0, 16);
}

/** The guest unit a publication's forwarder runs as. It is not an execution unit: nothing leases it, it
 * outlives the request that created it and is established again after a container restart. */
export function publicationUnit(publicationId) {
  return `elowen-pub-${publicationRuntimeToken(publicationId)}.service`;
}
