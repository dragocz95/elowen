import { describe, expect, it, vi } from 'vitest';
import {
  isGlobalIpAddress,
  makePinnedRequestOptions,
  resolvePublicHttpUrl,
} from '../../src/plugins/publicHttp.js';

const lookupResult = (address: string, family: 4 | 6) => ({ address, family });

describe('public HTTP address policy', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
    '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001:db8::1', '2001:2::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
  ])('rejects non-global address %s', (address) => {
    expect(isGlobalIpAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts global address %s', (address) => {
      expect(isGlobalIpAddress(address)).toBe(true);
    },
  );

  it('rejects a DNS answer set when any address is non-global', async () => {
    const lookup = vi.fn(async () => [lookupResult('93.184.216.34', 4), lookupResult('127.0.0.1', 4)]);
    await expect(resolvePublicHttpUrl('https://example.com/', lookup)).rejects.toThrow(/non-global/i);
  });
});

describe('public HTTP DNS pinning', () => {
  it('normalizes IDN and pins the validated address into the real request lookup while preserving SNI and Host', async () => {
    const lookup = vi.fn(async () => [lookupResult('93.184.216.34', 4)]);
    const pinned = await resolvePublicHttpUrl('https://bücher.example/path', lookup);
    expect(pinned.url.toString()).toBe('https://xn--bcher-kva.example/path');

    const options = makePinnedRequestOptions(pinned, { accept: 'text/plain' });
    expect(options.servername).toBe('xn--bcher-kva.example');
    expect(options.headers).toMatchObject({ host: 'xn--bcher-kva.example', accept: 'text/plain' });

    const callback = vi.fn();
    (options.lookup as Function)('xn--bcher-kva.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
