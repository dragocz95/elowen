import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PublishedSitesEnvironmentItem as ReadinessItem } from '../plugins/api.js';
import { logger, type Logger } from '../shared/logger.js';
import { encodeHelperRequest } from '../shared/siteGateway.js';
import { NSPAWN_DOMAIN, NSPAWN_HELPER_PATH, NSPAWN_MACHINE_PATTERN } from '../shared/nspawnRuntime.js';
import { environmentItem, siteGatewayHelperStatus, type SiteGatewayHelperMaintenance, installSiteGatewayHelper } from './publishedSitesGateway.js';

const auditLog = logger('nspawn-runtime');
const HELPER_TIMEOUT_MS = 30_000;
/** A bounded apt transaction may need repository metadata and package downloads. */
const PROVISION_TIMEOUT_MS = 12 * 60_000;
/** Extracting, copying, fingerprinting or removing a multi-gigabyte disk tree. */
const DISK_TIMEOUT_MS = 15 * 60_000;
/** Grace over the execution's own `RuntimeMaxSec`, matching the helper's backstop. */
const EXEC_GRACE_MS = 15_000;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export type NspawnResource = { kind: 'project'; id: number } | { kind: 'site'; id: string };
export type NspawnComponent = 'rootfs' | 'workspace' | 'home' | 'data' | 'broker' | 'disk';

export interface NspawnDiskRef {
  resource: NspawnResource;
  diskId: string;
  componentGeneration?: number;
}

export interface NspawnTreeRef extends NspawnDiskRef {
  component: NspawnComponent;
}

export interface NspawnExecInput {
  machine: string;
  unit: string;
  argv: readonly string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface NspawnExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export interface NspawnReadiness {
  ready: boolean;
  items: ReadinessItem[];
  detail?: string;
}

/** Every request carries the domain, so one executable serves two typed dispatch tables. No operation
 *  accepts a host path, a machine name or an argv the helper does not re-derive or re-validate itself. */
export type NspawnHelperRequest = { domain: typeof NSPAWN_DOMAIN } & (
  | { op: 'status' | 'provision'; veth?: boolean }
  | (NspawnDiskRef & { op: 'materialize'; archiveDigest: string; archiveBytes: number })
  | (NspawnDiskRef & {
    op: 'write-envelope';
    machine: string;
    limits: { cpus: number; memoryMb: number; pidsLimit: number };
    binds: readonly { component: NspawnComponent; target: string; readOnly?: boolean }[];
    veth?: boolean;
    specHash?: string;
  })
  | (NspawnDiskRef & { op: 'shift-ownership' })
  | ({ op: 'exec' } & NspawnExecInput)
  | { op: 'freeze' | 'thaw'; machine: string }
  | { op: 'tree-copy'; source: NspawnTreeRef; destination: NspawnTreeRef }
  | (NspawnTreeRef & { op: 'tree-fingerprint' | 'tree-sync' | 'tree-remove' })
  | (NspawnDiskRef & { op: 'destroy'; machine: string; removeDisk?: boolean })
);

interface HelperResponse {
  ok: boolean;
  ready?: boolean;
  items?: unknown[];
  detail?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  truncated?: boolean;
  stdout?: string;
  stderr?: string;
  digest?: string;
  logicalBytes?: number;
  allocatedBytes?: number;
  path?: string;
  machine?: string;
  unit?: string;
  uidBase?: number;
  envelopeDigest?: string;
}

export type NspawnHelperInvoker = (request: NspawnHelperRequest, input?: Buffer) => Promise<HelperResponse>;

export function nspawnHelperTimeoutMs(request: NspawnHelperRequest): number {
  if (request.op === 'exec') return request.timeoutSeconds * 1000 + EXEC_GRACE_MS;
  if (request.op === 'provision') return PROVISION_TIMEOUT_MS;
  if (request.op === 'materialize' || request.op === 'shift-ownership' || request.op.startsWith('tree-')) return DISK_TIMEOUT_MS;
  return HELPER_TIMEOUT_MS;
}

/** The guest's own stdin is written straight after the framed request and is never buffered by the
 *  helper: it reads the header with exact byte counts and hands the rest of the pipe to the child. */
function defaultInvoker(request: NspawnHelperRequest, input?: Buffer): Promise<HelperResponse> {
  if (!existsSync(NSPAWN_HELPER_PATH)) return Promise.reject(new Error('the machine runtime helper is not installed'));
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', NSPAWN_HELPER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('the machine runtime helper produced too much output'));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', () => finish(new Error('the machine runtime helper is not installed or cannot be executed')));
    child.once('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 1_000);
        reject(new Error(detail || `the machine runtime helper exited with status ${code ?? 'unknown'}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8').trim()) as HelperResponse;
        if (typeof parsed.ok !== 'boolean') throw new Error('missing verdict');
        resolve(parsed);
      } catch {
        reject(new Error('the machine runtime helper returned an invalid response'));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('the machine runtime helper timed out'));
    }, nspawnHelperTimeoutMs(request));
    timer.unref();
    child.stdin.write(encodeHelperRequest(request));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

const defaultHelperMaintenance: SiteGatewayHelperMaintenance = {
  status: () => siteGatewayHelperStatus(),
  install: () => installSiteGatewayHelper(),
};

/** The privileged machine-runtime control. The lifecycle itself (start, stop, set-property, show) runs
 *  as the service user over the polkit rule with no sudo; everything here is the remainder, which needs
 *  real root: namespace entry for execution, the cgroup freezer, and disk trees owned by the machine's
 *  own uid range. The daemon never mutates the firewall — veth readiness is reported and refused. */
export function createNspawnRuntimeControl(options: {
  invoke?: NspawnHelperInvoker;
  audit?: Pick<Logger, 'info' | 'warn'>;
  helper?: SiteGatewayHelperMaintenance;
} = {}) {
  const invoke = options.invoke ?? defaultInvoker;
  const audit = options.audit ?? auditLog;
  const helper = options.helper ?? defaultHelperMaintenance;

  const machine = (value: string): string => {
    if (!NSPAWN_MACHINE_PATTERN.test(value)) throw new Error('the machine name is invalid');
    return value;
  };

  const call = async (request: NspawnHelperRequest, input?: Buffer): Promise<HelperResponse> => {
    const result = await invoke(request, input);
    if (!result.ok) throw new Error(result.detail || 'the machine runtime helper refused the request');
    return result;
  };

  const readiness = async (op: 'status' | 'provision', veth: boolean): Promise<NspawnReadiness> => {
    try {
      if (op === 'provision') await helper.install();
      const helperItem = await helper.status();
      if (!helperItem.ok) {
        return { ready: false, items: [helperItem], detail: 'the installed privileged helper differs from this Elowen release' };
      }
      const result = await invoke({ domain: NSPAWN_DOMAIN, op, ...(veth ? { veth } : {}) });
      if (!result.ok) {
        return { ready: false, items: [helperItem], detail: result.detail || 'the machine runtime helper refused the request' };
      }
      const items = Array.isArray(result.items)
        ? result.items.map(environmentItem).filter((item): item is ReadinessItem => item !== null)
        : [];
      return {
        ready: result.ready === true && items.length > 0 && items.every((item) => item.ok),
        items: [helperItem, ...items],
        ...(typeof result.detail === 'string' && result.detail ? { detail: result.detail.slice(0, 500) } : {}),
      };
    } catch (error) {
      return { ready: false, items: [], detail: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    status: (input: { veth?: boolean } = {}) => readiness('status', input.veth === true),
    provision: async (input: { veth?: boolean } = {}) => {
      audit.info('machine runtime provisioning requested through the privileged control');
      const result = await readiness('provision', input.veth === true);
      if (result.ready) audit.info('machine runtime provisioning completed');
      else audit.warn('machine runtime provisioning remains incomplete', { failedItems: result.items.filter((item) => !item.ok).map((item) => item.id) });
      return result;
    },
    materialize: async (disk: NspawnDiskRef & { archiveDigest: string; archiveBytes: number }) => {
      const result = await call({ domain: NSPAWN_DOMAIN, op: 'materialize', ...disk });
      return { uidBase: result.uidBase ?? null, path: result.path ?? null };
    },
    writeEnvelope: async (input: Omit<Extract<NspawnHelperRequest, { op: 'write-envelope' }>, 'domain' | 'op'>) => {
      machine(input.machine);
      const result = await call({ domain: NSPAWN_DOMAIN, op: 'write-envelope', ...input });
      return { unit: result.unit ?? null, envelopeDigest: result.envelopeDigest ?? null };
    },
    shiftOwnership: async (disk: NspawnDiskRef) => {
      const result = await call({ domain: NSPAWN_DOMAIN, op: 'shift-ownership', ...disk });
      return { uidBase: result.uidBase ?? null };
    },
    exec: async (input: NspawnExecInput, guestInput?: Buffer): Promise<NspawnExecResult> => {
      machine(input.machine);
      const result = await call({ domain: NSPAWN_DOMAIN, op: 'exec', ...input }, guestInput);
      return {
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        signal: typeof result.signal === 'string' ? result.signal : null,
        timedOut: result.timedOut === true,
        truncated: result.truncated === true,
        stdout: Buffer.from(result.stdout ?? '', 'base64'),
        stderr: Buffer.from(result.stderr ?? '', 'base64'),
      };
    },
    freeze: async (name: string) => { await call({ domain: NSPAWN_DOMAIN, op: 'freeze', machine: machine(name) }); },
    thaw: async (name: string) => { await call({ domain: NSPAWN_DOMAIN, op: 'thaw', machine: machine(name) }); },
    treeCopy: async (source: NspawnTreeRef, destination: NspawnTreeRef) => {
      await call({ domain: NSPAWN_DOMAIN, op: 'tree-copy', source, destination });
    },
    treeFingerprint: async (tree: NspawnTreeRef) => {
      const result = await call({ domain: NSPAWN_DOMAIN, op: 'tree-fingerprint', ...tree });
      if (typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest)
        || !Number.isSafeInteger(result.logicalBytes) || !Number.isSafeInteger(result.allocatedBytes)) {
        throw new Error('the machine runtime helper returned an invalid disk tree fingerprint');
      }
      return { digest: result.digest, logicalBytes: result.logicalBytes as number, allocatedBytes: result.allocatedBytes as number };
    },
    treeSync: async (tree: NspawnTreeRef) => { await call({ domain: NSPAWN_DOMAIN, op: 'tree-sync', ...tree }); },
    treeRemove: async (tree: NspawnTreeRef) => { await call({ domain: NSPAWN_DOMAIN, op: 'tree-remove', ...tree }); },
    destroy: async (input: NspawnDiskRef & { machine: string; removeDisk?: boolean }) => {
      machine(input.machine);
      await call({ domain: NSPAWN_DOMAIN, op: 'destroy', ...input });
    },
  };
}

export type NspawnRuntimeControl = ReturnType<typeof createNspawnRuntimeControl>;
