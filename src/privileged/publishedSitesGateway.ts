import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  PublishedSitesEnvironmentItem,
  PublishedSitesGatewayControl,
  PublishedSitesGatewayStatus,
} from '../plugins/api.js';
import {
  encodeHelperRequest,
  SITE_GATEWAY_HELPER_ARGV,
  SITE_GATEWAY_HELPER_PATH,
  siteGatewayHelperInstallHint,
} from '../shared/siteGateway.js';
const SITE_GATEWAY_HELPER_SOURCE = fileURLToPath(new URL('../../scripts/elowen-site-gateway.mjs', import.meta.url));
const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
/** Issuance talks to a certificate authority over the network, so it gets its own budget. */
const ISSUE_TIMEOUT_MS = 6 * 60_000;
/** Machine-runtime provisioning runs a bounded apt transaction, which may need repository metadata and
 *  package downloads. */
const RUNTIME_PROVISION_TIMEOUT_MS = 12 * 60_000;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_EMAIL = /^[^\s@]{1,64}@[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export type SiteGatewayHelperRequest =
  | { op: 'sync-sites'; gatewayToken: string }
  | { op: 'ensure-site'; slug: string; email: string; gatewayToken: string }
  | { op: 'remove-site'; slug: string; gatewayToken: string }
  | { op: 'deny' }
  | { op: 'status' }
  | { domain: 'nspawn'; op: 'provision'; veth?: boolean; user?: string };

interface HelperResponse {
  ok: boolean;
  active?: boolean;
  hostnameBase?: string | null;
  ready?: boolean;
  items?: unknown[];
  detail?: string;
  slugs?: string[];
}

export type SiteGatewayHelperInvoker = (request: SiteGatewayHelperRequest) => Promise<HelperResponse>;

export interface SiteGatewayHelperInstallIO {
  readFile(path: string): Promise<Buffer>;
  /** Replace the installed helper with these bytes. Only root can write /usr/local/libexec. */
  install(path: string, data: Buffer): Promise<void>;
}

const defaultHelperInstallIO: SiteGatewayHelperInstallIO = {
  readFile: async (path) => await readFile(path),
  // Written beside the target and renamed over it, so the helper is never half-replaced: the daemon may
  // be invoking the installed copy at this moment. `writeFile`'s mode is subject to the umask, so the
  // mode is set again explicitly — a helper that is not executable is one sudo refuses to run.
  install: async (path, data) => {
    const staged = `${path}.staged-${process.pid}`;
    await writeFile(staged, data, { mode: 0o755, flag: 'wx' });
    await chmod(staged, 0o755);
    await rename(staged, path);
  },
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
        : `installed helper differs from this Elowen release. Run: ${siteGatewayHelperInstallHint(SITE_GATEWAY_HELPER_SOURCE)}`,
    };
  } catch (cause) {
    return {
      id: 'helper:site-gateway',
      label: 'Published-sites gateway helper',
      ok: false,
      detail: `helper cannot be verified: ${cause instanceof Error ? cause.message : String(cause)}. Run: ${siteGatewayHelperInstallHint(SITE_GATEWAY_HELPER_SOURCE)}`,
    };
  }
}

/** Refresh the installed helper from this release. Idempotent: a helper whose bytes already match the
 *  packaged copy is left alone, so a converged host reports false and nothing is written.
 *
 *  Root-only, and deliberately so. Replacing /usr/local/libexec/elowen-site-gateway is not granted in
 *  sudoers: a grant binds to a user rather than to the code path it was written for, so a pinned
 *  `install` whose SOURCE the service user can write would let that user choose root-trusted contents.
 *  The hourly auto-update timer runs as the service user, so it can only report drift; the caller decides
 *  what to say about that, and the release it was run for still lands. */
export async function installSiteGatewayHelper(io: SiteGatewayHelperInstallIO = defaultHelperInstallIO): Promise<boolean> {
  const status = await siteGatewayHelperStatus(io);
  if (status.ok) return false;
  if (process.getuid?.() !== 0) return false;
  await io.install(SITE_GATEWAY_HELPER_PATH, await io.readFile(SITE_GATEWAY_HELPER_SOURCE));
  return true;
}

/** Install the machine runtime's host artefacts: the container tools package, the unit template, the
 *  polkit rule, the firewall unit and the network prerequisites a virtual ethernet needs. The helper does
 *  the work and is idempotent, so this converges rather than repeating.
 *
 *  `veth` is asked for because an ordinary environment asks for one. Leaving it out reported a prepared
 *  host while forwarding was off and the link service was disabled, so the install said ready and the
 *  first environment still could not be created.
 *
 *  It is wired into the install and the update because there is no other way in. The runtime refuses to
 *  create an environment while any of the three is missing and there is deliberately no fallback, so a
 *  host that never runs this can create nothing and the only repair would be writing root-owned files by
 *  hand. Both paths reach it: a fresh install as one of its steps, and an existing instance through the
 *  same refresh that brings the helper itself forward.
 *
 *  Both of those paths run as root, where the inner sudo reports `root` as the invoking account and the
 *  helper cannot derive the service user from it. The account the environments belong to is therefore
 *  named: the installer knows it from the plan, an update reads it from the root-owned install record, and
 *  the helper resolves it through passwd and accepts it only from a root caller. */
export async function provisionMachineRuntime(serviceUser: string | null, invoke: SiteGatewayHelperInvoker = defaultInvoker): Promise<boolean> {
  const response = await invoke({ domain: 'nspawn', op: 'provision', veth: true, ...(serviceUser ? { user: serviceUser } : {}) });
  if (response.ready === false) {
    const blocking = (response.items ?? []).filter((item): item is { ok: boolean; label?: string; detail?: string } =>
      typeof item === 'object' && item !== null && (item as { ok?: unknown }).ok === false);
    // A row that is still unmet after a convergent run is something this host will not let the helper
    // fix — an unsupported kernel, a packet filter that is not iptables. Naming it is the point.
    throw new Error(`machine runtime support is incomplete — ${blocking.map((item) => `${item.label ?? 'requirement'}: ${item.detail ?? 'not met'}`).join('; ') || response.detail || 'no detail reported'}`);
  }
  return response.ready === true;
}

export function siteGatewayHelperTimeoutMs(request: SiteGatewayHelperRequest): number {
  if (request.op === 'ensure-site') return ISSUE_TIMEOUT_MS;
  if (request.op === 'provision') return RUNTIME_PROVISION_TIMEOUT_MS;
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

/** Build the narrow control published sites receive. Hostname and system paths never come from the
 * plugin: the hostname is derived from trusted install metadata here, while the root helper derives all
 * paths and the loopback upstream from its own root-owned deployment record. */
export function createPublishedSitesGatewayControl(options: {
  publicWebUrl: string | null;
  invoke?: SiteGatewayHelperInvoker;
}): PublishedSitesGatewayControl {
  const base = hostnameBase(options.publicWebUrl);
  const invoke = options.invoke ?? defaultInvoker;

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
  };
}
