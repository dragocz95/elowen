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

  /** A file the plugin recognises as a PDF by its header. The page-spec check runs before poppler is ever
   *  invoked, so this suite needs no real document and no poppler on the host. */
  const stubPdf = (dir: string): string => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, '%PDF-1.4\n');
    return path;
  };

  it('states the CONFIGURED cap in the Read description and parameter, not the built-in 20', async () => {
    const reg = await load({ pdfMaxPages: 5 });
    const read = toolOf(reg, 'Read');
    // The model only ever learns the cap from these two strings. If they keep saying 20 while validation
    // enforces 5, every wider request it makes is a failure it had no way to see coming.
    expect(read.description).toContain('at most 5 pages per call');
    expect(read.description).not.toContain('at most 20 pages per call');
    expect(read.parameters.properties?.pages?.description).toContain('max 5 per call');
  });

  it('keeps saying 20 when nothing is configured', async () => {
    const read = toolOf(await load(), 'Read');
    expect(read.description).toContain('at most 20 pages per call');
    expect(read.parameters.properties?.pages?.description).toContain('max 20 per call');
  });

  it('enforces the same configured cap when a spec asks for more', async () => {
    const dir = tmpDir('files-pdf-cap');
    const pdf = stubPdf(dir);
    const reg = await load({ pdfMaxPages: 5 });
    const res = await runWithPolicy(
      userPolicy([dir]),
      () => toolOf(reg, 'Read').execute('t', { path: pdf, pages: '1-6' }),
      { sessionId: 'brain-pdf-cap' },
    );
    expect(res.content[0]?.text).toContain('more than 5 pages');
    expect(res.details).toMatchObject({ ok: false });
  });

  it('quotes the configured cap in the missing-`pages` error too', async () => {
    const dir = tmpDir('files-pdf-hint');
    const pdf = stubPdf(dir);
    const reg = await load({ pdfMaxPages: 50 });
    const res = await runWithPolicy(
      userPolicy([dir]),
      () => toolOf(reg, 'Read').execute('t', { path: pdf }),
      { sessionId: 'brain-pdf-hint' },
    );
    expect(res.content[0]?.text).toContain('max 50 per call');
  });

  it('clamps an out-of-range value to the manifest bounds', async () => {
    expect(toolOf(await load({ pdfMaxPages: 1 }), 'Read').description).toContain('at most 5 pages per call');
    expect(toolOf(await load({ pdfMaxPages: 999 }), 'Read').description).toContain('at most 50 pages per call');
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
