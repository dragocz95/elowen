import { describe, expect, it } from 'vitest';
import { trustedPublicWebUrl } from '../../src/shared/publicWebUrl.js';

describe('trustedPublicWebUrl', () => {
  it('normalizes canonical HTTPS and localhost development URLs', () => {
    expect(trustedPublicWebUrl('https://elowen.example/')).toBe('https://elowen.example');
    expect(trustedPublicWebUrl('http://localhost:4500/')).toBe('http://localhost:4500');
    expect(trustedPublicWebUrl('http://127.0.0.1:4500/')).toBe('http://127.0.0.1:4500');
    expect(trustedPublicWebUrl('http://[::1]:4500/')).toBe('http://[::1]:4500');
  });

  it('rejects credentials, request-like fragments, public HTTP and non-web schemes', () => {
    expect(trustedPublicWebUrl('http://elowen.example')).toBeNull();
    expect(trustedPublicWebUrl('https://token@elowen.example')).toBeNull();
    expect(trustedPublicWebUrl('https://elowen.example/?from=host')).toBeNull();
    expect(trustedPublicWebUrl('javascript:alert(1)')).toBeNull();
  });
});
