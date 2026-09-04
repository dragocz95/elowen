import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const owner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1 };

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };

interface ToolResult { content: { text?: string }[]; details?: Record<string, unknown> }
/** The declared shape of a registered tool — the description and parameter text the MODEL is shown. */
interface ToolShape {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string } | undefined> };
  execute(id: string, p: unknown): Promise<ToolResult>;
}
const toolOf = (reg: PluginRegistry, name: string): ToolShape => {
  const found = reg.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found as unknown as ToolShape;
};

describe('files — pdfMaxPages', () => {
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  const load = (config?: Record<string, unknown>) => loadPlugins({
    dirs: [pluginsDir], enabled: ['files'], logger: log,
    config: config ? { files: config } : undefined,
  });

  /** A real eleven-page PDF. `Read` asks pdfinfo for the page count before applying the configured request
   * cap, so a header-only stub would test malformed-PDF handling instead of the limit this suite owns. */
  const stubPdf = (dir: string): string => {
    const pages = 11;
    const fontObj = 3 + pages * 2;
    const objects: string[] = [];
    objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
    objects[2] = `<</Type/Pages/Kids[${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${pages}>>`;
    for (let i = 0; i < pages; i += 1) {
      const pageObj = 3 + i * 2;
      const contentObj = pageObj + 1;
      const stream = `BT /F1 12 Tf 20 100 Td (Page ${i + 1}) Tj ET`;
      objects[pageObj] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentObj} 0 R/Resources<</Font<</F1 ${fontObj} 0 R>>>>>>`;
      objects[contentObj] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
    }
    objects[fontObj] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 1; i < objects.length; i += 1) {
      offsets[i] = body.length;
      body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = body.length;
    body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i += 1) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, Buffer.from(body, 'latin1'));
    return path;
  };

  it('states the configured safe cap in the Read description and parameter', async () => {
    const reg = await load({ pdfMaxPages: 10 });
    const read = toolOf(reg, 'Read');
    // Fable fixes the absolute ceiling at 20, while the operator may safely tighten it to 10.
    expect(read.description).toContain('at most 10 pages per call');
    expect(read.description).not.toContain('at most 20 pages per call');
    expect(read.parameters.properties?.pages?.description).toContain('max 10 per call');
  });

  it('keeps saying 20 when nothing is configured', async () => {
    const read = toolOf(await load(), 'Read');
    expect(read.description).toContain('at most 20 pages per call');
    expect(read.parameters.properties?.pages?.description).toContain('max 20 per call');
  });

  it('enforces the same configured cap when a spec asks for more', async () => {
    const dir = tmpDir('files-pdf-cap');
    const pdf = stubPdf(dir);
    const reg = await load({ pdfMaxPages: 10 });
    const res = await runWithPolicy(
      userPolicy([dir]),
      () => toolOf(reg, 'Read').execute('t', { file_path: pdf, pages: '1-11' }),
      { sessionId: 'brain-pdf-cap' },
    );
    expect(res.content[0]?.text).toContain('more than 10 pages');
    expect(res.details).toMatchObject({ ok: false });
  });

  it('clamps an out-of-range value to the Fable-compatible manifest bounds', async () => {
    expect(toolOf(await load({ pdfMaxPages: 1 }), 'Read').description).toContain('at most 10 pages per call');
    expect(toolOf(await load({ pdfMaxPages: 999 }), 'Read').description).toContain('at most 20 pages per call');
  });
});

describe('terminal — maxBackgroundProcesses', () => {
  // The registry is a module-level singleton shared across the whole run; a background sleep left behind
  // would leak into other files. Kill everything, then drop the dirs those processes ran in.
  afterEach(() => {
    for (const p of processRegistry.list()) processRegistry.kill(p.id);
    for (const p of dirs) rmSync(p, { recursive: true, force: true });
    dirs = [];
  });

  const load = (config?: Record<string, unknown>) => loadPlugins({
    dirs: [pluginsDir], enabled: ['terminal'], logger: log,
    config: config ? { terminal: config } : undefined,
  });

  const startBackground = (reg: PluginRegistry, dir: string, sessionId: string) => runWithPolicy(
    userPolicy([dir]),
    () => toolOf(reg, 'Bash').execute('t', { command: 'sleep 30', background: true }),
    { identity: owner, sessionId },
  );

  it('refuses the next background process at the CONFIGURED limit, naming it', async () => {
    const dir = tmpDir('term-bg-cap');
    const reg = await load({ maxBackgroundProcesses: 1 });

    const first = await startBackground(reg, dir, 'brain-bg-cap');
    expect(first.content[0]?.text).not.toContain('too many background processes');

    const second = await startBackground(reg, dir, 'brain-bg-cap');
    expect(second.content[0]?.text).toContain('too many background processes (1)');
  });

  it('lets the same second process through on the default limit', async () => {
    const dir = tmpDir('term-bg-default');
    const reg = await load();

    await startBackground(reg, dir, 'brain-bg-default');
    const second = await startBackground(reg, dir, 'brain-bg-default');
    expect(second.content[0]?.text).not.toContain('too many background processes');
  });

  /** A handle that occupies a background slot without spawning anything — the cheap way to fill a session
   *  up to the ceiling. The registry drops it on kill(), so afterEach clears these with the real ones. */
  const occupySlot = (id: string, sessionId: string, cwd: string): void => {
    processRegistry.register({
      id, command: 'placeholder', cwd, startedAt: new Date().toISOString(),
      sessionId, accountUserId: 1, completionMode: 'job',
      running: () => true, exitCode: () => null, readAll: () => '', kill: () => {},
    });
  };

  it('clamps a value above the ceiling down to 64 instead of honouring it verbatim', async () => {
    const dir = tmpDir('term-bg-ceiling');
    const reg = await load({ maxBackgroundProcesses: 999 });
    const session = 'brain-bg-ceiling';
    for (let i = 0; i < 63; i += 1) occupySlot(`ceiling-${i}`, session, dir);

    const atLimit = await startBackground(reg, dir, session); // the 64th
    expect(atLimit.content[0]?.text).not.toContain('too many background processes');

    const past = await startBackground(reg, dir, session);
    expect(past.content[0]?.text).toContain('too many background processes (64)');
  });
});
