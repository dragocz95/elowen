import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPublishedSitesGatewayControl,
  installSiteGatewayHelper,
  siteGatewayHelperStatus,
  siteGatewayHelperTimeoutMs,
} from '../../src/privileged/publishedSitesGateway.js';
import { SITE_GATEWAY_HELPER_PATH } from '../../src/shared/siteGateway.js';

const TOKEN = 'a'.repeat(43);
const MODULE_SOURCE = readFileSync(new URL('../../src/privileged/publishedSitesGateway.ts', import.meta.url), 'utf8');

/** The two files the maintenance code reads, and the one way it may replace the installed copy. */
function helperIO(installed: string) {
  const installs: { path: string; data: Buffer }[] = [];
  const install = vi.fn(async (path: string, data: Buffer) => { installs.push({ path, data }); });
  return {
    installs,
    install,
    readFile: async (path: string) => Buffer.from(path.includes('/scripts/') ? 'shipped helper' : installed),
  };
}

/** The account the process runs as decides whether a root-owned file can be replaced at all. */
function runningAs(uid: number) {
  vi.spyOn(process, 'getuid').mockReturnValue(uid);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('published sites gateway helper maintenance', () => {
  it('compares shipped and installed content digests, and names the command an operator can run', async () => {
    expect(await siteGatewayHelperStatus(helperIO('shipped helper'))).toMatchObject({ ok: true });
    const drifted = await siteGatewayHelperStatus(helperIO('stale helper'));
    expect(drifted).toMatchObject({ ok: false, detail: expect.stringContaining('sudo install -o root -g root -m 0755') });
    expect(drifted.detail).toContain(SITE_GATEWAY_HELPER_PATH);
  });

  it('leaves a current helper alone, and never touches the installed copy twice', async () => {
    runningAs(0);
    const equal = helperIO('shipped helper');
    expect(await installSiteGatewayHelper(equal)).toBe(false);
    expect(equal.install).not.toHaveBeenCalled();
  });

  it('replaces a drifted helper from this release when it already runs as root', async () => {
    runningAs(0);
    const drifted = helperIO('stale helper');
    expect(await installSiteGatewayHelper(drifted)).toBe(true);
    expect(drifted.installs).toEqual([{ path: SITE_GATEWAY_HELPER_PATH, data: Buffer.from('shipped helper') }]);
  });

  // The regression this whole change is about: the refresh used to be an `install` from a path under
  // /tmp, granted passwordlessly in sudoers. A grant binds to a USER rather than to the code path it was
  // written for, so the service user could write that source first and choose what root installed. The
  // hourly auto-update timer runs as the service user, which is exactly that account.
  it('does not try to replace a root-owned file as the service user', async () => {
    runningAs(1000);
    const drifted = helperIO('stale helper');
    expect(await installSiteGatewayHelper(drifted)).toBe(false);
    expect(drifted.install).not.toHaveBeenCalled();
  });

  it('spawns sudo for the pinned helper argv only, and installs nothing through it', () => {
    expect(MODULE_SOURCE).toContain("spawn('sudo', [...SITE_GATEWAY_HELPER_ARGV]");
    expect(MODULE_SOURCE).not.toContain('/usr/bin/install');
    expect(MODULE_SOURCE).not.toContain("'-n',");
  });
});

describe('published sites gateway control', () => {
  it('derives the only hostname a plugin may request from trusted deployment metadata', () => {
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://Agent.Example.com/' });
    expect(control.hostnameBase()).toBe('sites.agent.example.com');
    expect(createPublishedSitesGatewayControl({ publicWebUrl: 'http://localhost:4500' }).hostnameBase()).toBeNull();
    expect(createPublishedSitesGatewayControl({ publicWebUrl: null }).hostnameBase()).toBeNull();
  });

  it('never invokes a privileged helper without a trusted HTTPS domain deployment', async () => {
    const invoke = vi.fn();
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'http://127.0.0.1:4500', invoke });
    expect(await control.status()).toEqual(expect.objectContaining({ available: false, active: false }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('routes only certificate issuance and runtime provisioning to extended bounded timeouts', () => {
    expect(siteGatewayHelperTimeoutMs({ op: 'status' })).toBe(30_000);
    expect(siteGatewayHelperTimeoutMs({ op: 'ensure-site', slug: 'alpha', email: 'ops@example.com', gatewayToken: TOKEN })).toBe(6 * 60_000);
    // Machine-runtime provisioning runs an apt transaction, which is the one call budgeted in minutes.
    expect(siteGatewayHelperTimeoutMs({ domain: 'nspawn', op: 'provision', veth: true })).toBe(12 * 60_000);
  });

  it('asks the helper for one site at a time, by slug, over the bounded protocol', async () => {
    const invoke = vi.fn(async () => ({ ok: true, active: true, hostnameBase: 'sites.agent.example.com' }));
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });

    expect(await control.ensureSite({ slug: 'dashboard-abc123', email: 'ops@example.com', gatewayToken: TOKEN }))
      .toEqual({ available: true, active: true, hostnameBase: 'sites.agent.example.com' });
    await control.removeSite({ slug: 'dashboard-abc123', gatewayToken: TOKEN });

    expect(invoke.mock.calls.map(([request]) => request)).toEqual([
      { op: 'ensure-site', slug: 'dashboard-abc123', email: 'ops@example.com', gatewayToken: TOKEN },
      { op: 'remove-site', slug: 'dashboard-abc123', gatewayToken: TOKEN },
    ]);
  });

  it('reports the sites that already hold a certificate', async () => {
    const invoke = vi.fn(async () => ({ ok: true, active: true, hostnameBase: 'sites.agent.example.com', slugs: ['alpha', 42, 'beta'] }));
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });
    // The helper is trusted to be root-owned, not to be well-typed: the list crosses a process boundary
    // as JSON and is filtered before any caller treats an entry as a slug.
    expect(await control.syncSites({ gatewayToken: TOKEN })).toEqual({
      available: true, active: true, hostnameBase: 'sites.agent.example.com', slugs: ['alpha', 'beta'],
    });
    expect(invoke).toHaveBeenCalledWith({ op: 'sync-sites', gatewayToken: TOKEN });
  });

  it('refuses a malformed slug, email or token before starting sudo', async () => {
    const invoke = vi.fn();
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });

    expect((await control.ensureSite({ slug: '../etc', email: 'ops@example.com', gatewayToken: TOKEN })).available).toBe(false);
    expect((await control.ensureSite({ slug: 'ok-site', email: 'not-an-email', gatewayToken: TOKEN })).available).toBe(false);
    expect((await control.ensureSite({ slug: 'ok-site', email: 'ops@example.com', gatewayToken: 'short' })).available).toBe(false);
    expect((await control.removeSite({ slug: 'UPPER', gatewayToken: TOKEN })).available).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed when the root helper is configured for another deployment', async () => {
    const control = createPublishedSitesGatewayControl({
      publicWebUrl: 'https://agent.example.com',
      invoke: async () => ({ ok: true, active: true, hostnameBase: 'sites.other.example.com' }),
    });
    expect(await control.status()).toEqual(expect.objectContaining({
      available: false,
      active: false,
      detail: 'the root helper is configured for a different public hostname',
    }));
  });
});
