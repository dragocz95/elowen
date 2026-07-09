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
  it('accepts an optional showOutput list (tool-output policy), absent by default', () => {
    expect(parseManifest(good).showOutput).toBeUndefined();
    const m = parseManifest({ ...good, showOutput: ['run_command', 'lsp_*'] });
    expect(m.showOutput).toEqual(['run_command', 'lsp_*']);
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
        { key: 'sec', label: 'Section', type: 'section' },
        { key: 'en', label: 'Enum', type: 'enum' },
        { key: 'ms', label: 'Multi', type: 'multiSelect' },
        { key: 'code', label: 'Code', type: 'code' },
        { key: 'prompt', label: 'Prompt', type: 'prompt' },
        { key: 'json', label: 'Json', type: 'json' },
        { key: 'emb', label: 'Embedding', type: 'embeddingModel' },
      ],
    });
    const types = m.configSchema?.map((f) => f.type);
    for (const t of ['model', 'provider', 'section', 'enum', 'multiSelect', 'code', 'prompt', 'json', 'embeddingModel']) {
      expect(types).toContain(t);
    }
    expect(m.configSchema?.find((f) => f.type === 'provider')?.providerType).toBe('openai');
  });
  it('accepts options/help/risk/visibleWhen/language props', () => {
    const m = parseManifest({
      ...good,
      configSchema: [
        {
          key: 'mode', label: 'Mode', type: 'enum',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          help: 'Pick a mode.', risk: 'high',
        },
        {
          key: 'body', label: 'Body', type: 'code', language: 'python',
          visibleWhen: { key: 'mode', equals: 'a' },
        },
      ],
    });
    const en = m.configSchema?.find((f) => f.key === 'mode');
    expect(en?.options).toEqual([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
    expect(en?.help).toBe('Pick a mode.');
    expect(en?.risk).toBe('high');
    const code = m.configSchema?.find((f) => f.key === 'body');
    expect(code?.language).toBe('python');
    expect(code?.visibleWhen).toEqual({ key: 'mode', equals: 'a' });
  });
  it('accepts a valid capabilities block', () => {
    const m = parseManifest({
      ...good,
      capabilities: { hooks: ['brain.turn.beforeContext'], mutates: ['turnContext', 'tools'], reads: ['weather'], network: true },
    });
    expect(m.capabilities?.mutates).toEqual(['turnContext', 'tools']);
    expect(m.capabilities?.network).toBe(true);
  });
  it('accepts a manifest with no capabilities (deny-by-default)', () => {
    expect(parseManifest(good).capabilities).toBeUndefined();
  });
  it('rejects an invalid mutates literal', () => {
    expect(() => parseManifest({ ...good, capabilities: { mutates: ['filesystem'] } })).toThrow();
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
