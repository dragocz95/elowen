import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;
const freshDataRoot = () => mkdtempSync(join(tmpdir(), 'orca-qw-'));

describe('runtime-context plugin', () => {
  it('registers a turn-context provider that emits the current date/time', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['runtime-context'], dataRoot: freshDataRoot(), logger: log, config: { 'runtime-context': { timezone: 'Europe/Prague' } } });
    expect(reg.turnContexts).toHaveLength(1);
    const out = reg.turnContexts[0]!();
    expect(out).toMatch(/Current date & time:/);
    expect(out).toContain('Europe/Prague');
    expect(reg.tools).toHaveLength(0); // it adds NO tools and NO system-prompt fragment
    expect(reg.promptFragments).toHaveLength(0);
  });
});

describe('security-scan plugin', () => {
  it('scan() flags dangerous patterns with severity + line numbers', async () => {
    const { scan } = await import(join(pluginsDir, 'security-scan/index.mjs')) as {
      scan: (s: string) => { line: number; id: string; sev: string }[];
    };
    const code = [
      'const x = 1;',
      'eval(userInput);',
      'import pickle',
      'data = pickle.loads(raw)',
      'subprocess.run(cmd, shell=True)',
      'const key = "api_key: abcdef0123456789xyz"',
    ].join('\n');
    const f = scan(code);
    const ids = f.map((x) => x.id);
    expect(ids).toContain('js-eval');
    expect(ids).toContain('pickle');
    expect(ids).toContain('shell-true');
    expect(f.find((x) => x.id === 'pickle')!.sev).toBe('danger');
    // a clean line is not flagged
    expect(f.some((x) => x.line === 1)).toBe(false);
  });

  it('scan_code tool returns a clean bill for safe code', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['security-scan'], dataRoot: freshDataRoot(), logger: log });
    const tool = reg.tools.find((t) => t.name === 'scan_code')!;
    const res = await runWithPolicy(ADMIN, () => tool.execute('t', { code: 'const a = 1 + 1;' }, undefined as never, undefined as never));
    expect(asText(res)).toMatch(/No risky patterns/);
  });
});

describe('image-edit plugin', () => {
  const resolveProvider = (id: string) => id === 'oai'
    ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' } : null;
  it('registers nothing without a provider', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['image-edit'], dataRoot: freshDataRoot(), resolveProvider, logger: log });
    expect(reg.tools).toHaveLength(0);
  });
  it('registers edit_image with a provider', async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['image-edit'], dataRoot: freshDataRoot(), logger: log, resolveProvider, config: { 'image-edit': { provider: 'oai' } } });
    expect(reg.tools.map((t) => t.name)).toEqual(['edit_image']);
  });
});
