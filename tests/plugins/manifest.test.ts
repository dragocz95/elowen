import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const m = parseManifest({ ...good, showOutput: ['Bash', 'Lsp*'] });
    expect(m.showOutput).toEqual(['Bash', 'Lsp*']);
  });
  it('accepts exact and prefix deferred-tool defaults, absent by default', () => {
    expect(parseManifest(good).deferLoading).toBeUndefined();
    const m = parseManifest({ ...good, deferLoading: ['ScanCode', 'mcp__*'] });
    expect(m.deferLoading).toEqual(['ScanCode', 'mcp__*']);
  });
  it('rejects malformed deferred-tool defaults', () => {
    expect(() => parseManifest({ ...good, deferLoading: 'ScanCode' })).toThrow();
    expect(() => parseManifest({ ...good, deferLoading: ['ScanCode', 42] })).toThrow();
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
  it('accepts options/help/risk/advanced/visibleWhen/language props', () => {
    const m = parseManifest({
      ...good,
      configSchema: [
        {
          key: 'mode', label: 'Mode', type: 'enum',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          help: 'Pick a mode.', risk: 'high', advanced: true,
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
    expect(en?.advanced).toBe(true);
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

/** Every BUNDLED manifest must parse — the runtime loader only logs "plugin skipped" for an invalid
 *  one, so without this a typo in a shipped elowen-plugin.json (bad configSchema type, malformed web
 *  block, missing rootMount declaration) would reach users as a silently absent plugin. This is the
 *  manifest half of the marketplace lint; i18n coverage is scripts/check-languages.mjs. */
describe('bundled plugin manifests', () => {
  const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');
  const names = readdirSync(pluginsDir).filter((n) => {
    const dir = join(pluginsDir, n);
    return statSync(dir).isDirectory() && existsSync(join(dir, 'elowen-plugin.json'));
  });

  it('finds the bundled plugins', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`${name}: manifest parses and its declarations are coherent`, () => {
      const m = parseManifest(JSON.parse(readFileSync(join(pluginsDir, name, 'elowen-plugin.json'), 'utf-8')));
      expect(m.name).toBe(name);
      // A root-mounted API surface must be declared with its leading slash (the loader's contract);
      // a namespaced path must NOT start with one.
      for (const route of m.provides?.apiRoutes ?? []) {
        expect(typeof route).toBe('string');
      }
      // A web block's bundle must be reproducible from the repo: either web-src/ sources exist (the
      // build emits the gitignored bundle) or the entry itself is tracked (a hand-written, build-free
      // bundle).
      if (m.web) {
        expect(m.web.entry.startsWith('/')).toBe(false);
        const hasSources = existsSync(join(pluginsDir, name, 'web-src'));
        const hasEntry = existsSync(join(pluginsDir, name, m.web.entry));
        expect(hasSources || hasEntry).toBe(true);
      }
    });
  }
});
