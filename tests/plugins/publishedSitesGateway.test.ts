import { describe, expect, it, vi } from 'vitest';
import { createPublishedSitesGatewayControl } from '../../src/privileged/publishedSitesGateway.js';

const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
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

  it('sends certificate material over the bounded helper protocol, not as a path or command', async () => {
    const invoke = vi.fn(async () => ({ ok: true, active: true, hostnameBase: 'sites.agent.example.com' }));
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });
    expect(await control.ensure({ certificatePem: CERTIFICATE, privateKeyPem: PRIVATE_KEY, gatewayToken: TOKEN }))
      .toEqual({ available: true, active: true, hostnameBase: 'sites.agent.example.com' });
    expect(invoke).toHaveBeenCalledWith({
      op: 'apply', certificatePem: CERTIFICATE, privateKeyPem: PRIVATE_KEY, gatewayToken: TOKEN,
    });
  });

  it('refuses malformed secrets before starting sudo', async () => {
    const invoke = vi.fn();
    const control = createPublishedSitesGatewayControl({ publicWebUrl: 'https://agent.example.com', invoke });
    expect((await control.ensure({ certificatePem: 'x', privateKeyPem: 'y', gatewayToken: 'short' })).available).toBe(false);
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
