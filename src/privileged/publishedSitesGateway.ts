import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type {
  PublishedSitesEnvironmentItem,
  PublishedSitesEnvironmentStatus,
  PublishedSitesGatewayControl,
  PublishedSitesGatewayStatus,
} from '../plugins/api.js';
import { logger, type Logger } from '../shared/logger.js';
import {
  encodeHelperRequest,
  SITE_GATEWAY_HELPER_INSTALL_ARGS,
  SITE_GATEWAY_HELPER_INSTALL_SOURCE,
  SITE_GATEWAY_HELPER_ARGV,
  SITE_GATEWAY_HELPER_PATH,
  SITE_RUNTIME_SOCKET_ROOT,
} from '../shared/siteGateway.js';
const execFileAsync = promisify(execFile);
const SITE_GATEWAY_HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
const SITE_GATEWAY_HELPER_INSTALL_COMMAND = `sudo -n /usr/bin/install ${SITE_GATEWAY_HELPER_INSTALL_ARGS.join(' ')}`;
const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
/** Issuance talks to a certificate authority over the network, so it gets its own budget. */
const ISSUE_TIMEOUT_MS = 6 * 60_000;
/** A bounded apt transaction may need repository metadata and package downloads. */
const ENVIRONMENT_PROVISION_TIMEOUT_MS = 12 * 60_000;
const auditLog = logger('published-sites-gateway');
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_EMAIL = /^[^\s@]{1,64}@[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export type SiteGatewayHelperRequest =
  | { op: 'sync-sites'; gatewayToken: string }
  | { op: 'ensure-site'; slug: string; email: string; gatewayToken: string }
  | { op: 'remove-site'; slug: string; gatewayToken: string }
  | { op: 'deny' }
  | { op: 'status' }
  | { op: 'environments-status' }
  | { op: 'environments-provision' }
  | { domain: 'nspawn'; op: 'provision' }
  | { op: 'prepare-runtime-socket'; siteId: string }
  | { op: 'seal-runtime-socket'; siteId: string }
  | { op: 'remove-runtime-socket'; siteId: string };

interface HelperResponse {
  ok: boolean;
  active?: boolean;
  hostnameBase?: string | null;
  ready?: boolean;
  items?: unknown[];
  detail?: string;
  socketPath?: string;
  slugs?: string[];
}

export type SiteGatewayHelperInvoker = (request: SiteGatewayHelperRequest) => Promise<HelperResponse>;

export interface SiteGatewayHelperMaintenance {
  status(): Promise<PublishedSitesEnvironmentItem>;
  install(): Promise<boolean>;
}

export interface SiteGatewayHelperInstallIO {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  exec(command: string, args: string[]): Promise<void>;
  remove(path: string): Promise<void>;
}

const defaultHelperInstallIO: SiteGatewayHelperInstallIO = {
  readFile: async (path) => await readFile(path),
  writeFile: async (path, data) => { await writeFile(path, data, { mode: 0o600 }); },
  exec: async (command, args) => { await execFileAsync(command, args); },
  remove: async (path) => { await rm(path, { force: true }); },
};

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function siteGatewayHelperStatus(io: SiteGatewayHelperInstallIO = defaultHelperInstallIO): Promise<PublishedSitesEnvironmentItem> {
  try {
    const [shipped, installed] = await Promise.all([
      io.readFile(SITE_GATEWAY_HELPER_SOURCE),
      io.readFile(SITE_GATEWAY_HELPER_PATH),
    ]);
    const ok = digest(shipped) === digest(installed);
    return {
      id: 'helper:site-gateway',
      label: 'Published-sites gateway helper',
      ok,
      detail: ok
        ? 'installed helper matches this Elowen release'
        : `installed helper differs from this Elowen release. Run: ${SITE_GATEWAY_HELPER_INSTALL_COMMAND}`,
    };
  } catch (cause) {
    return {
      id: 'helper:site-gateway',
      label: 'Published-sites gateway helper',
      ok: false,
      detail: `helper cannot be verified: ${cause instanceof Error ? cause.message : String(cause)}. Run: ${SITE_GATEWAY_HELPER_INSTALL_COMMAND}`,
    };
  }
}

export async function installSiteGatewayHelper(io: SiteGatewayHelperInstallIO = defaultHelperInstallIO): Promise<boolean> {
  const status = await siteGatewayHelperStatus(io);
  if (status.ok) return false;
  const source = await io.readFile(SITE_GATEWAY_HELPER_SOURCE);
  await io.writeFile(SITE_GATEWAY_HELPER_INSTALL_SOURCE, source);
  try {
    await io.exec('sudo', ['-n', '/usr/bin/install', ...SITE_GATEWAY_HELPER_INSTALL_ARGS]);
  } finally {
    await io.remove(SITE_GATEWAY_HELPER_INSTALL_SOURCE);
  }
  return true;
}

/** Install the machine runtime's host artefacts: the container tools package, the unit template and the
 *  polkit rule. The helper does the work and is idempotent, so this converges rather than repeating.
 *
 *  It is wired into the install and the update because there is no other way in. The runtime refuses to
 *  create an environment while any of the three is missing and there is deliberately no fallback, so a
 *  host that never runs this can create nothing and the only repair would be writing root-owned files by
 *  hand. Both paths reach it: a fresh install as one of its steps, and an existing instance through the
 *  same refresh that brings the helper itself forward. */
export async function provisionMachineRuntime(invoke: SiteGatewayHelperInvoker = defaultInvoker): Promise<boolean> {
  const response = await invoke({ domain: 'nspawn', op: 'provision' });
  if (response.ready === false) {
    const blocking = (response.items ?? []).filter((item): item is { ok: boolean; label?: string; detail?: string } =>
      typeof item === 'object' && item !== null && (item as { ok?: unknown }).ok === false);
    // Not every unmet row is this command's to fix: the firewall rules are the operator's and are only
    // ever reported. Naming them is the point; failing on them would be wrong.
    throw new Error(`machine runtime support is incomplete — ${blocking.map((item) => `${item.label ?? 'requirement'}: ${item.detail ?? 'not met'}`).join('; ') || response.detail || 'no detail reported'}`);
  }
  return response.ready === true;
}

const defaultHelperMaintenance: SiteGatewayHelperMaintenance = {
  status: () => siteGatewayHelperStatus(),
  install: () => installSiteGatewayHelper(),
};

export function siteGatewayHelperTimeoutMs(request: SiteGatewayHelperRequest): number {
  if (request.op === 'ensure-site') return ISSUE_TIMEOUT_MS;
  if (request.op === 'environments-provision' || request.op === 'provision') return ENVIRONMENT_PROVISION_TIMEOUT_MS;
  return HELPER_TIMEOUT_MS;
}

function hostnameBase(publicWebUrl: string | null): string | null {
  if (!publicWebUrl) return null;
  try {
    const url = new URL(publicWebUrl);
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.hostname === 'localhost') return null;
    return `sites.${url.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

function defaultInvoker(request: SiteGatewayHelperRequest): Promise<HelperResponse> {
  if (!existsSync(SITE_GATEWAY_HELPER_PATH)) {
    return Promise.reject(new Error('the site gateway helper is not installed'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', [...SITE_GATEWAY_HELPER_ARGV], {
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
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('the site gateway helper produced too much output'));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', () => finish(new Error('the site gateway helper is not installed or cannot be executed')));
    child.once('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      const out = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 1_000);
        reject(new Error(detail || `the site gateway helper exited with status ${code ?? 'unknown'}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as HelperResponse;
        if (typeof parsed.ok !== 'boolean') throw new Error('missing verdict');
        resolve(parsed);
      } catch {
        reject(new Error('the site gateway helper returned an invalid response'));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('the site gateway helper timed out'));
    }, siteGatewayHelperTimeoutMs(request));
    timer.unref();
    // The domain is added here rather than in each typed request, so the whole Sites surface keeps its
    // existing shape while the helper always receives the discriminator explicitly.
    child.stdin.end(encodeHelperRequest({ domain: 'sites', ...request }));
  });
}

function unavailable(detail: string): PublishedSitesGatewayStatus {
  return { available: false, active: false, hostnameBase: null, detail };
}

function environmentsUnavailable(detail: string): PublishedSitesEnvironmentStatus {
  return { ready: false, items: [], detail };
}

/** One readiness row as it crosses the helper boundary. */
function environmentItem(value: unknown): PublishedSitesEnvironmentItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || item.id.length > 80) return null;
  if (typeof item.label !== 'string' || !item.label || item.label.length > 120) return null;
  if (typeof item.ok !== 'boolean') return null;
  return {
    id: item.id,
    label: item.label,
    ok: item.ok,
    ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail.slice(0, 500) } : {}),
  };
}

/** Build the narrow control published sites receive. Hostname and system paths never come from the
 * plugin: the hostname is derived from trusted install metadata here, while the root helper derives all
 * paths and the loopback upstream from its own root-owned deployment record. */
export function createPublishedSitesGatewayControl(options: {
  publicWebUrl: string | null;
  invoke?: SiteGatewayHelperInvoker;
  audit?: Pick<Logger, 'info' | 'warn'>;
  helper?: SiteGatewayHelperMaintenance;
}): PublishedSitesGatewayControl {
  const base = hostnameBase(options.publicWebUrl);
  const invoke = options.invoke ?? defaultInvoker;
  const audit = options.audit ?? auditLog;
  const helper = options.helper ?? defaultHelperMaintenance;

  const call = async (request: SiteGatewayHelperRequest): Promise<PublishedSitesGatewayStatus> => {
    if (!base) return unavailable('published sites require a trusted HTTPS domain deployment');
    try {
      const result = await invoke(request);
      if (!result.ok) return unavailable(result.detail || 'the site gateway helper refused the request');
      if (result.hostnameBase !== undefined && result.hostnameBase !== base) {
        return unavailable('the root helper is configured for a different public hostname');
      }
      return {
        available: true,
        active: result.active === true,
        hostnameBase: base,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(Array.isArray(result.slugs) ? { slugs: result.slugs.filter((slug) => typeof slug === 'string') } : {}),
      };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  };

  const environmentsCall = async (op: 'environments-status' | 'environments-provision'): Promise<PublishedSitesEnvironmentStatus> => {
    try {
      if (op === 'environments-provision') await helper.install();
      const helperItem = await helper.status();
      if (!helperItem.ok) {
        return {
          ready: false,
          items: [helperItem],
          detail: 'the installed published-sites gateway helper differs from this Elowen release',
        };
      }
      const result = await invoke({ op });
      if (!result.ok) return { ...environmentsUnavailable(result.detail || 'the site gateway helper refused the request'), items: [helperItem] };
      const items = Array.isArray(result.items)
        ? result.items.map(environmentItem).filter((item): item is PublishedSitesEnvironmentItem => item !== null)
        : [];
      return {
        ready: result.ready === true && items.length > 0 && items.every((item) => item.ok),
        items: [helperItem, ...items],
        ...(typeof result.detail === 'string' && result.detail ? { detail: result.detail.slice(0, 500) } : {}),
      };
    } catch (error) {
      return environmentsUnavailable(error instanceof Error ? error.message : String(error));
    }
  };

  const socketCall = async (op: 'prepare-runtime-socket' | 'seal-runtime-socket' | 'remove-runtime-socket', siteId: string): Promise<string> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)) {
      throw new Error('site id is invalid');
    }
    const expected = join(SITE_RUNTIME_SOCKET_ROOT, siteId, 'app.sock');
    const result = await invoke({ op, siteId });
    if (!result.ok) throw new Error(result.detail || 'the site gateway helper refused the runtime socket request');
    if (result.socketPath !== expected) throw new Error('the site gateway helper returned an unexpected runtime socket path');
    return expected;
  };

  return {
    hostnameBase: () => base,
    syncSites: async ({ gatewayToken }) => {
      if (!SAFE_TOKEN.test(gatewayToken)) return unavailable('the internal gateway token is malformed');
      return call({ op: 'sync-sites', gatewayToken });
    },
    ensureSite: async ({ slug, email, gatewayToken }) => {
      if (!SAFE_SLUG.test(slug)) return unavailable('the site slug is malformed');
      if (!SAFE_EMAIL.test(email) || email.length > 254) return unavailable('a contact email is required for certificate issuance');
      if (!SAFE_TOKEN.test(gatewayToken)) return unavailable('the internal gateway token is malformed');
      return call({ op: 'ensure-site', slug, email, gatewayToken });
    },
    removeSite: async ({ slug, gatewayToken }) => {
      if (!SAFE_SLUG.test(slug)) return unavailable('the site slug is malformed');
      if (!SAFE_TOKEN.test(gatewayToken)) return unavailable('the internal gateway token is malformed');
      return call({ op: 'remove-site', slug, gatewayToken });
    },
    deny: () => call({ op: 'deny' }),
    status: () => call({ op: 'status' }),
    environmentsStatus: () => environmentsCall('environments-status'),
    provisionEnvironments: async () => {
      audit.info('published sites environment provisioning requested through the privileged control');
      const result = await environmentsCall('environments-provision');
      const failedItems = result.items.filter((item) => !item.ok).map((item) => item.id);
      if (result.ready) audit.info('published sites environment provisioning completed');
      else audit.warn('published sites environment provisioning remains incomplete', { failedItems });
      return result;
    },
    prepareRuntimeSocket: async (siteId) => ({ path: await socketCall('prepare-runtime-socket', siteId) }),
    sealRuntimeSocket: async (siteId) => { await socketCall('seal-runtime-socket', siteId); },
    removeRuntimeSocket: async (siteId) => { await socketCall('remove-runtime-socket', siteId); },
  };
}
