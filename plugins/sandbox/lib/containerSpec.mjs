import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize } from 'node:path';

const trustedSpecs = new WeakSet();
export const DEFAULT_CONTAINER_LIMITS = Object.freeze({ cpus: 1, memoryMb: 1024, pidsLimit: 512 });

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
  return buildSpec(input, paths, null);
}

/** Handover-only capability, built from the trusted Sites record and audited engine observations.
 * Names and mount targets are fixed by the legacy Sites contract, never supplied by a guest. Persist
 * containerId, imageId, volumeMountpoint and the resulting specHash with the handover generation;
 * the daemon must revalidate that record before dispatch. This does not relabel or recreate anything. */
export function createLegacySiteSpec(input, binding) {
  closed(binding, ['sitesDataDir', 'sourcePath', 'brokerDir', 'containerId', 'imageId', 'volumeMountpoint']);
  if (input?.resource?.kind !== 'site') throw new Error('A legacy binding must identify a Site');
  for (const key of ['sitesDataDir', 'sourcePath', 'brokerDir', 'volumeMountpoint']) hostPath(binding[key]);
  if (!/^[a-f0-9]{64}$/.test(binding.containerId) || !/^(sha256:)?[a-f0-9]{64}$/.test(binding.imageId)) throw new Error('Invalid legacy container/image identity');
  return buildSpec(input, {
    sitesDataDir: binding.sitesDataDir, siteSourcesDir: dirname(binding.sourcePath), siteBrokerDir: dirname(binding.brokerDir),
  }, { ...binding });
}

function buildSpec(input, paths, legacy) {
  closed(input, ['resource', 'generation', 'image', 'limits', 'network', 'workspaceReadOnly']);
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
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...input.limits };
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 1024 || !Number.isSafeInteger(limits.cpus * 1e6)) throw new Error('Invalid CPU limit');
  for (const key of ['memoryMb', 'pidsLimit']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 2 ** 30) throw new Error(`Invalid ${key} limit`);
  }
  const namespace = resourceToken(paths.namespace ?? 'elowen');
  const resource = { kind, id };
  const generation = input.generation;
  const name = legacy ? `elowen-site-${id}` : `${namespace}-${kind}-${id}-g${generation}`;
  const storageRoot = kind === 'project'
    ? join(hostPath(paths.sandboxDataDir), 'projects', String(id))
    : join(hostPath(paths.sitesDataDir), id, 'environment');
  const components = kind === 'project' ? ['workspace', 'home', 'data'] : ['data'];
  const volumes = components.map((component) => ({
    component, name: `${name}-${component}`, path: legacy ? legacy.volumeMountpoint : join(storageRoot, 'storage', String(generation), component),
  }));
  const mounts = kind === 'project'
    ? volumes.map((volume) => ({ type: 'volume', source: volume.name, target: { workspace: '/workspace', home: '/root', data: '/data' }[volume.component], readOnly: false }))
    : [
      { type: 'bind', source: legacy ? legacy.sourcePath : join(hostPath(paths.siteSourcesDir), id), target: '/workspace', readOnly: input.workspaceReadOnly ?? false },
      { type: 'bind', source: join(storageRoot, 'git-stub'), target: '/workspace/.git', readOnly: true },
      { type: 'bind', source: legacy ? legacy.brokerDir : join(hostPath(paths.siteBrokerDir), id), target: '/run/elowen', readOnly: false },
      { type: 'volume', source: volumes[0].name, target: '/data', readOnly: false },
    ];
  const settings = {
    resource, generation, namespace, name, image: input.image, limits, legacy,
    ipcMode: legacy ? 'shareable' : 'private',
    network: network === 'isolated' ? 'none' : 'slirp4netns:allow_host_loopback=false',
    storageRoot, volumes, mounts, envFile: kind === 'site' ? join(storageRoot, 'container.env') : null,
  };
  const hash = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  /** @type {Record<string, string>} */
  const labels = legacy ? { 'io.elowen.site': id } : {
    'io.elowen.runtime': 'sandbox', 'io.elowen.namespace': namespace,
    'io.elowen.resource': `${kind}:${id}`, 'io.elowen.generation': String(generation), 'io.elowen.spec': hash,
    ...(kind === 'site' ? { 'io.elowen.site': id } : {}),
  };
  const spec = { ...settings, specHash: hash, labels };
  freeze(spec);
  trustedSpecs.add(spec);
  return spec;
}

export function assertContainerSpec(spec) {
  if (!trustedSpecs.has(spec)) throw new Error('A trusted host-derived container specification is required');
  return spec;
}

export function volumeLabels(spec, component) {
  assertContainerSpec(spec);
  if (!spec.volumes.some((volume) => volume.component === component)) throw new Error('Unknown storage component');
  if (spec.legacy) return { 'io.elowen.site': spec.resource.id };
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
