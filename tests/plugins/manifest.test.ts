import { describe, it, expect } from 'vitest';
import { parseManifest, PLUGIN_API_VERSION } from '../../src/plugins/manifest.js';

const good = { name: 'skills', version: '0.1.0', apiVersion: PLUGIN_API_VERSION, description: 'x', entry: 'index.mjs' };

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(good).name).toBe('skills');
  });
  it('accepts optional requires/provides', () => {
    const m = parseManifest({ ...good, requires: { env: ['X'] }, provides: { skills: ['*'] } });
    expect(m.provides?.skills).toEqual(['*']);
  });
  it('accepts every declared config field type, including the model picker', () => {
    const m = parseManifest({
      ...good,
      configSchema: [
        { key: 'k1', label: 'S', type: 'string' },
        { key: 'k2', label: 'Sec', type: 'secret' },
        { key: 'k3', label: 'B', type: 'boolean' },
        { key: 'k4', label: 'N', type: 'number' },
        { key: 'k5', label: 'T', type: 'textarea' },
        { key: 'k6', label: 'R', type: 'rolePolicies' },
        { key: 'model', label: 'Model', type: 'model' },
        { key: 'prov', label: 'Provider', type: 'provider', providerType: 'openai' },
      ],
    });
    expect(m.configSchema?.map((f) => f.type)).toContain('model');
    expect(m.configSchema?.map((f) => f.type)).toContain('provider');
    expect(m.configSchema?.find((f) => f.type === 'provider')?.providerType).toBe('openai');
  });
  it('rejects an unknown config field type', () => {
    expect(() => parseManifest({ ...good, configSchema: [{ key: 'k', label: 'L', type: 'wat' }] })).toThrow();
  });
  it('rejects a missing required field', () => {
    expect(() => parseManifest({ ...good, name: undefined })).toThrow();
  });
  it('rejects an apiVersion mismatch', () => {
    expect(() => parseManifest({ ...good, apiVersion: '999' })).toThrow(/apiVersion/);
  });
  it('rejects a non-object', () => {
    expect(() => parseManifest('nope')).toThrow();
  });
});
