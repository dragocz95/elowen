import { describe, expect, it, vi } from 'vitest';
import {
  createPublishedSitesGatewayControl,
  siteGatewayHelperTimeoutMs,
} from '../../src/privileged/publishedSitesGateway.js';

const TOKEN = 'a'.repeat(43);

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

  it('publishes the exact environment readiness and provisioning control shape', async () => {
    const invoke = vi.fn(async (request: { op: string }) => ({
      ok: true,
      ready: true,
      items: [{ id: 'package:podman', label: 'Podman', ok: true, detail: 'installed' }],
      detail: request.op,
    }));
    const audit = { info: vi.fn(), warn: vi.fn() };
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke, audit });

    expect(await control.environmentsStatus()).toEqual({
      ready: true,
      items: [{ id: 'package:podman', label: 'Podman', ok: true, detail: 'installed' }],
      detail: 'environments-status',
    });
    expect(await control.provisionEnvironments()).toEqual(expect.objectContaining({ ready: true }));
    expect(invoke.mock.calls.map(([request]) => request)).toEqual([
      { op: 'environments-status' },
      { op: 'environments-provision' },
    ]);
    expect(audit.info).toHaveBeenCalledTimes(2);
    expect(audit.warn).not.toHaveBeenCalled();
    expect('environmentSupportStatus' in control).toBe(false);
    expect('installEnvironmentSupport' in control).toBe(false);
  });

  it('routes only certificate issuance and environment provisioning to extended bounded timeouts', () => {
    expect(siteGatewayHelperTimeoutMs({ op: 'status' })).toBe(30_000);
    expect(siteGatewayHelperTimeoutMs({ op: 'ensure-site', slug: 'alpha', email: 'ops@example.com', gatewayToken: TOKEN })).toBe(6 * 60_000);
    expect(siteGatewayHelperTimeoutMs({ op: 'environments-provision' })).toBe(12 * 60_000);
    expect(siteGatewayHelperTimeoutMs({ op: 'environments-status' })).toBe(30_000);
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

  it('brokers a fixed root-owned pathname socket for confined runtimes', async () => {
    const siteId = '123e4567-e89b-12d3-a456-426614174000';
    const socketPath = `/var/lib/elowen/site-runtime-sockets/${siteId}/app.sock`;
    const invoke = vi.fn(async () => ({ ok: true, socketPath }));
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });
    expect(await control.prepareRuntimeSocket(siteId)).toEqual({ path: socketPath });
    await control.sealRuntimeSocket(siteId);
    await control.removeRuntimeSocket(siteId);
    expect(invoke.mock.calls.map(([request]) => request)).toEqual([
      { op: 'prepare-runtime-socket', siteId },
      { op: 'seal-runtime-socket', siteId },
      { op: 'remove-runtime-socket', siteId },
    ]);
  });

  it('rejects a helper that tries to redirect a runtime socket path', async () => {
    const control = createPublishedSitesGatewayControl({
      publicWebUrl: 'https://agent.example.com',
      invoke: async () => ({ ok: true, socketPath: '/run/elowen-daemon.sock' }),
    });
    await expect(control.prepareRuntimeSocket('123e4567-e89b-12d3-a456-426614174000'))
      .rejects.toThrow(/unexpected runtime socket path/);
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
