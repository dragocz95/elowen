import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PublishedSitesGatewayControl, PublishedSitesGatewayStatus } from '../plugins/api.js';
import { SITE_GATEWAY_HELPER_PATH, SITE_RUNTIME_SOCKET_ROOT } from '../shared/siteGateway.js';
const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
/** Issuance talks to a certificate authority over the network, so it gets its own budget. */
const ISSUE_TIMEOUT_MS = 6 * 60_000;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_EMAIL = /^[^\s@]{1,64}@[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

type HelperRequest =
  | { op: 'ensure-site'; slug: string; email: string; gatewayToken: string }
  | { op: 'remove-site'; slug: string; gatewayToken: string }
  | { op: 'deny' }
  | { op: 'status' }
  | { op: 'prepare-runtime-socket'; siteId: string }
  | { op: 'seal-runtime-socket'; siteId: string }
  | { op: 'remove-runtime-socket'; siteId: string };

interface HelperResponse {
  ok: boolean;
  active?: boolean;
  hostnameBase?: string | null;
  detail?: string;
  socketPath?: string;
  slugs?: string[];
}

export type SiteGatewayHelperInvoker = (request: HelperRequest) => Promise<HelperResponse>;

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

function defaultInvoker(request: HelperRequest): Promise<HelperResponse> {
  if (!existsSync(SITE_GATEWAY_HELPER_PATH)) {
    return Promise.reject(new Error('the site gateway helper is not installed'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', SITE_GATEWAY_HELPER_PATH], {
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
    }, request.op === 'ensure-site' ? ISSUE_TIMEOUT_MS : HELPER_TIMEOUT_MS);
    timer.unref?.();
    child.stdin.end(JSON.stringify(request));
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

  const call = async (request: HelperRequest): Promise<PublishedSitesGatewayStatus> => {
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
      };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
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
    prepareRuntimeSocket: async (siteId) => ({ path: await socketCall('prepare-runtime-socket', siteId) }),
    sealRuntimeSocket: async (siteId) => { await socketCall('seal-runtime-socket', siteId); },
    removeRuntimeSocket: async (siteId) => { await socketCall('remove-runtime-socket', siteId); },
  };
}
