import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize } from 'node:path';

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

export function createBoundSiteSpec(input, binding) {
  closed(binding, ['sitesDataDir', 'sourcePath', 'brokerDir', 'namespace']);
  if (input?.resource?.kind !== 'site') throw new Error('A Site binding is required');
  for (const key of ['sitesDataDir', 'sourcePath', 'brokerDir']) hostPath(binding[key]);
  return buildSpec(input, { namespace: binding.namespace, sitesDataDir: binding.sitesDataDir, siteSourcesDir: dirname(binding.sourcePath), siteBrokerDir: dirname(binding.brokerDir) }, binding);
}

/** Keep creation ownership labels stable while validating the effective cgroup settings. */
export function withContainerLimits(spec, requested) {
  assertContainerSpec(spec);
  closed(requested, ['cpus', 'memoryMb', 'pidsLimit', 'diskSoftMb']);
  const limits = { cpus: requested.cpus, memoryMb: requested.memoryMb, pidsLimit: requested.pidsLimit };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 1024 || !Number.isSafeInteger(limits.cpus * 1e6)) throw new Error('Invalid CPU limit');
  for (const key of ['memoryMb', 'pidsLimit']) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 2 ** 30) throw new Error(`Invalid ${key} limit`);
  const next = { ...spec, limits, specHash: createHash('sha256').update(JSON.stringify({ creation: spec.labels['io.elowen.spec'] ?? spec.specHash, limits })).digest('hex') };
  freeze(next); trustedSpecs.add(next); return next;
}

function buildSpec(input, paths, binding = null) {
  closed(input, ['resource', 'generation', 'image', 'limits', 'network', 'workspaceReadOnly', 'previewBroker', 'workspaceTarget']);
  if (input.previewBroker !== undefined && (input.resource?.kind !== 'project' || typeof input.previewBroker !== 'boolean')) throw new Error('Invalid preview broker policy');
  closed(input.resource, ['kind', 'id']);
  const { kind, id } = input.resource;
  if (kind !== 'project' && kind !== 'site') throw new Error('Invalid container resource kind');
  if (kind === 'project' && (!Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid project ID');
  if (kind === 'site') resourceToken(id);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid runtime generation');
  if (typeof input.image !== 'string' || !/^[a-z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(input.image)) throw new Error('Invalid container image');
  const network = input.network ?? 'shared';
  if (network !== 'shared' && network !== 'isolated') throw new Error('Invalid container network');
  if (input.workspaceReadOnly !== undefined && (kind !== 'site' || typeof input.workspaceReadOnly !== 'boolean')) throw new Error('Invalid read-only workspace policy');
  closed(input.limits ?? {}, ['cpus', 'memoryMb', 'pidsLimit']);
  // A container keeps the limits it was created with until an explicit limits action updates them
  // through `withContainerLimits`, which is the only path that also runs `podman update`.
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...input.limits };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 1024 || !Number.isSafeInteger(limits.cpus * 1e6)) throw new Error('Invalid CPU limit');
  for (const key of ['memoryMb', 'pidsLimit']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 2 ** 30) throw new Error(`Invalid ${key} limit`);
  }
  const namespace = resourceToken(paths.namespace ?? 'elowen');
  const resource = { kind, id };
  const generation = input.generation;
  const name = `${namespace}-${kind}-${id}-g${generation}`;
  const storageRoot = kind === 'project'
    ? join(hostPath(paths.sandboxDataDir), 'projects', String(id))
    : join(hostPath(paths.sitesDataDir), id, 'environment');
  const components = kind === 'project' ? ['workspace', 'home', 'data'] : ['data'];
  const volumes = components.map((component) => ({
    component, name: `${name}-${component}`, path: join(storageRoot, 'storage', String(generation), component),
  }));
  // A project is mounted under its own name; a Site keeps the anonymous `/workspace` its published
  // containers were created with.
  const workdir = kind === 'project' ? guestMountTarget(input.workspaceTarget) : '/workspace';
  const mounts = kind === 'project'
    ? volumes.map((volume) => ({ type: 'volume', source: volume.name, target: { workspace: workdir, home: '/root', data: '/data' }[volume.component], readOnly: false }))
    : [
      { type: 'bind', source: binding?.sourcePath ?? join(hostPath(paths.siteSourcesDir), id), target: '/workspace', readOnly: input.workspaceReadOnly ?? false },
      { type: 'bind', source: join(storageRoot, 'git-stub'), target: '/workspace/.git', readOnly: true },
      { type: 'bind', source: binding?.brokerDir ?? join(hostPath(paths.siteBrokerDir), id), target: '/run/elowen', readOnly: false },
      { type: 'volume', source: volumes[0].name, target: '/data', readOnly: false },
    ];
  if (input.previewBroker) mounts.push({ type: 'bind', source: join(storageRoot, 'broker'), target: '/run/elowen', readOnly: false });
  const settings = {
    resource, generation, namespace, name, image: input.image, limits,
    workdir,
    ipcMode: 'private',
    network: network === 'isolated' ? 'none' : 'slirp4netns:allow_host_loopback=false',
    storageRoot, volumes, mounts, envFile: kind === 'site' ? join(storageRoot, 'container.env') : null,
  };
  // The hash preimage keeps the `legacy: null` key every spec carried while Sites containers created by
  // an earlier runtime could still be adopted. It is the identity in the `io.elowen.spec` label of every
  // container created so far, so dropping it from the preimage would make each of them fail ownership.
  // `workdir` is deliberately NOT part of the preimage: for a Site it is the unchanged `/workspace`, and
  // adding the key would change the identity of every Site container already created. A project's mount
  // target changes the hash through its `mounts` entry, which is what actually differs in the container.
  // (`JSON.stringify` drops an undefined value, so the preimage is byte-identical to the one every
  // existing container was hashed from.)
  const preimage = { resource, generation, namespace, name, image: input.image, limits, legacy: null, ...settings, workdir: undefined };
  const hash = createHash('sha256').update(JSON.stringify(preimage)).digest('hex');
  /** @type {Record<string, string>} */
  const labels = {
    'io.elowen.runtime': 'sandbox', 'io.elowen.namespace': namespace,
    'io.elowen.resource': `${kind}:${id}`, 'io.elowen.generation': String(generation), 'io.elowen.spec': hash,
    ...(kind === 'site' ? { 'io.elowen.site': id } : {}),
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

export function volumeLabels(spec, component) {
  assertContainerSpec(spec);
  if (!spec.volumes.some((volume) => volume.component === component)) throw new Error('Unknown storage component');
  return {
    'io.elowen.runtime': 'sandbox', 'io.elowen.namespace': spec.namespace,
    'io.elowen.resource': `${spec.resource.kind}:${spec.resource.id}`,
    'io.elowen.generation': String(spec.generation), 'io.elowen.component': component,
  };
}

export function executionUnit(spec, executionId) {
  assertContainerSpec(spec);
  if (typeof executionId !== 'string' || !/^[a-f0-9]{32}$/.test(executionId)) throw new Error('Invalid host execution ID');
  return `elowen-exec-g${spec.generation}-${executionId}.service`;
}

export function snapshotReference(spec, snapshotId) {
  assertContainerSpec(spec);
  resourceToken(snapshotId);
  return `localhost/${spec.namespace}-${spec.resource.kind}/${spec.resource.id}:g${spec.generation}-${snapshotId}`;
}
