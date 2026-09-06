import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginHookBus } from '../../src/plugins/hookBus.js';
import { composeSessionTools, type PluginToolResultEvent } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

interface ToolResult { content: { text?: string }[]; details?: Record<string, unknown> }
type Execute = (id: string, p: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) => Promise<ToolResult>;

// A file mutation reaches other plugins ONLY through `tools.call.after` — the seam the host already
// awaits between a plugin tool's execute and its result (spawner.ts wires it, capabilities.ts fires it).
// The LSP plugin uses it to keep a language server's open-document view fresh after an edit, so what a
// subscriber can read off the payload is a contract: the tool name, the path it was called with, and
// whether the write actually happened. A refused or failed Edit still RESOLVES (it never throws), so
// `details.ok` is the only thing separating "the bytes on disk changed" from "nothing happened" — a
// subscriber that skipped that check would push a phantom change into the server.
describe('files plugin — file mutations observable through tools.call.after', () => {
  let reg: PluginRegistry;
  let dir: string;
  let n = 0;
  let session: string;
  let seen: PluginToolResultEvent[];

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-observer-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { n += 1; session = `brain-observer-${n}`; seen = []; });

  /** The production wiring: plugin tools composed with the observer that forwards to the hook bus. */
  const tools = () => {
    const bus = new PluginHookBus({
      hooks: [{ name: 'tools.call.after' as const, run: (payload) => { seen.push(payload as PluginToolResultEvent); } }],
      hookOwners: ['lsp'],
      logger: log,
    });
    return composeSessionTools({
      kind: 'owner-chat',
      pluginTools: reg.tools,
      onToolResult: (e) => bus.emit('tools.call.after', e),
    });
  };

  const call = (name: string, params: Record<string, unknown>) => {
    const composed = tools().find((t) => t.name === name);
    if (!composed) throw new Error(`tool ${name} not composed`);
    return runWithPolicy(
      userPolicy([dir]),
      () => (composed.execute as unknown as Execute)('t', params, undefined, undefined, undefined),
      { sessionId: session },
    );
  };

  const fixture = (name: string, body: string) => {
    const path = join(dir, `${n}-${name}`);
    writeFileSync(path, body);
    return path;
  };

  const mutations = (tool: string) => seen.filter((e) => e.tool === tool);
  const details = (e: PluginToolResultEvent) => (e.result as ToolResult).details ?? {};

  it('delivers a successful Edit with the path it was called with and ok:true', async () => {
    const path = fixture('edit.ts', 'const a = 1;\n');
    await call('Read', { file_path: path });
    await call('Edit', { file_path: path, old_string: 'const a = 1;', new_string: 'const a = 2;' });

    expect(readFileSync(path, 'utf-8')).toBe('const a = 2;\n');
    const [event, ...rest] = mutations('Edit');
    expect(rest).toEqual([]);
    expect(event?.params).toMatchObject({ file_path: path });
    expect(details(event!)).toMatchObject({ ok: true });
  });

  it('delivers a successful Write the same way', async () => {
    const path = join(dir, `${n}-write.ts`); // a brand-new file needs no prior Read
    await call('Write', { file_path: path, content: 'export const b = 3;\n' });

    expect(readFileSync(path, 'utf-8')).toBe('export const b = 3;\n');
    const [event, ...rest] = mutations('Write');
    expect(rest).toEqual([]);
    expect(event?.params).toMatchObject({ file_path: path });
    expect(details(event!)).toMatchObject({ ok: true });
  });

  // The event fires for a FAILED edit too, because a failed Edit resolves with an error result instead of
  // throwing. `ok:false` is what a subscriber must gate on; nothing on disk changed here.
  it('marks a failed Edit ok:false so no subscriber mistakes it for a change', async () => {
    const path = fixture('nomatch.ts', 'const a = 1;\n');
    await call('Read', { file_path: path });
    await call('Edit', { file_path: path, old_string: 'const zzz = 9;', new_string: 'const a = 2;' });

    expect(readFileSync(path, 'utf-8')).toBe('const a = 1;\n'); // untouched
    const [event] = mutations('Edit');
    expect(event).toBeDefined();
    expect(details(event!)).toMatchObject({ ok: false });
  });

  it('marks a guard-refused Write ok:false as well', async () => {
    const path = fixture('unread.ts', 'const precious = 1;\n');
    await call('Write', { file_path: path, content: 'clobbered' });

    expect(readFileSync(path, 'utf-8')).toBe('const precious = 1;\n'); // untouched
    const [event] = mutations('Write');
    expect(event).toBeDefined();
    expect(details(event!)).toMatchObject({ ok: false });
  });

  // ONE mechanism: the files plugin announces a write through the shared seam and nowhere else. Its only
  // hook is the read-guard reseed it SUBSCRIBES to; it broadcasts no mutation event of its own, because a
  // second, files-specific channel would be a parallel mechanism for the same fact.
  it('adds no mutation channel of its own — the shared seam is the only one', () => {
    expect(reg.hooks.map((h) => h.name)).toEqual(['brain.session.afterSpawn']);
  });

  // No subscriber, no work: with nothing registered for the name, the bus fans out to nobody and the
  // tool result is unchanged. This is what keeps the LSP behaviour free when the plugin is absent.
  it('costs nothing when no plugin subscribes', async () => {
    const path = join(dir, `${n}-nosub.ts`);
    const bus = new PluginHookBus({ hooks: [], hookOwners: [], logger: log });
    const composed = composeSessionTools({
      kind: 'owner-chat',
      pluginTools: reg.tools,
      onToolResult: (e) => bus.emit('tools.call.after', e),
    }).find((t) => t.name === 'Write');
    const res = await runWithPolicy(
      userPolicy([dir]),
      () => (composed!.execute as unknown as Execute)('t', { file_path: path, content: 'x\n' }, undefined, undefined, undefined),
      { sessionId: session },
    );

    expect(res.details).toMatchObject({ ok: true });
    expect(readFileSync(path, 'utf-8')).toBe('x\n');
    expect(seen).toEqual([]);
  });
});
