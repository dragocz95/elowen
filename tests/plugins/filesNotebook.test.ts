import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

interface ToolResult {
  content: { type: string; text?: string; mimeType?: string; data?: string }[];
  details?: Record<string, unknown>;
}

const runTool = (reg: PluginRegistry, params: Record<string, unknown>) => {
  const tool = reg.tools.find((candidate) => candidate.name === 'Read');
  if (!tool) throw new Error('Read not registered');
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<ToolResult> }).execute('t', params);
};

describe('Read — Jupyter notebooks', () => {
  let reg: PluginRegistry;
  let dir: string;

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-notebook-'));
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('renders cells, text outputs, errors, and supported image outputs structurally', async () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
    const file = join(dir, 'analysis.ipynb');
    writeFileSync(file, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Heading\n', 'Notebook intro'] },
        {
          cell_type: 'code', execution_count: 7, metadata: {}, source: ['print("hello")'], outputs: [
            { output_type: 'stream', name: 'stdout', text: ['hello\n'] },
            { output_type: 'execute_result', execution_count: 7, metadata: {}, data: { 'text/plain': ['42'], 'image/png': image } },
            { output_type: 'error', ename: 'ValueError', evalue: 'bad value', traceback: ['Trace line one', 'Trace line two'] },
          ],
        },
      ],
    }));

    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, { file_path: file }), { sessionId: 'brain-notebook' });
    const text = res.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain('Cell 1 [markdown]');
    expect(text).toContain('# Heading\nNotebook intro');
    expect(text).toContain('Cell 2 [code, execution_count=7]');
    expect(text).toContain('print("hello")');
    expect(text).toContain('Output 1 [stream stdout]');
    expect(text).toContain('hello');
    expect(text).toContain('Output 2 [execute_result]');
    expect(text).toContain('42');
    expect(text).toContain('Output 3 [error ValueError: bad value]');
    expect(text).toContain('Trace line one\nTrace line two');
    const imageBlock = res.content.find((block) => block.type === 'image');
    expect(imageBlock).toMatchObject({ type: 'image', mimeType: 'image/png', data: image });
    expect(res.details).toMatchObject({ ok: true, notebook: true, cells: 2, images: 1 });
  });

  it('reports malformed notebooks as an error instead of returning raw JSON', async () => {
    const file = join(dir, 'broken.ipynb');
    writeFileSync(file, '{not json');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, { file_path: file }), { sessionId: 'brain-notebook-broken' });
    expect(res.content[0].text).toMatch(/Error.*notebook/i);
    expect(res.details).toMatchObject({ ok: false, notebook: true });
  });
});
