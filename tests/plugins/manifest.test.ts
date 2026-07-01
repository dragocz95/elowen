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
