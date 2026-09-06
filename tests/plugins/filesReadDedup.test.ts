import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginHookBus } from '../../src/plugins/hookBus.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

const STUB = 'File unchanged since last read. The content from the earlier Read tool_result '
  + 'in this conversation is still current — refer to that instead of re-reading.';

interface ToolResult { content: { text?: string }[]; details?: Record<string, unknown> }
const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as {
    execute: (id: string, p: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) => Promise<ToolResult>;
  }).execute('t', params);
};

// A second Read of the same range of an unchanged file resends content the earlier tool_result still
// carries. The stub points at that copy instead — without ever loosening what the read-before-write guard
// knows, which is the only thing the recorded hash is for.
describe('files plugin — Read dedup of an unchanged range', () => {
  let reg: PluginRegistry;
  let dir: string;
  let n = 0;

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-dedup-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  let session: string;
  beforeEach(() => { n += 1; session = `brain-dedup-${n}`; });

  const inSession = (name: string, params: Record<string, unknown>, sid = session) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { sessionId: sid });

  const afterSpawn = (sid: string, messages: unknown[]) =>
    new PluginHookBus({ hooks: reg.hooks }).emit('brain.session.afterSpawn', { sessionId: sid, messages });

  const fixture = (name: string, body: string) => {
    const path = join(dir, `${n}-${name}`);
    writeFileSync(path, body);
    return path;
  };

  it('answers a repeated identical Read with the stub instead of the same bytes again', async () => {
    const path = fixture('repeat.txt', 'alpha\nbeta\n');
    const first = await inSession('Read', { file_path: path });
    expect(first.content[0].text).toContain('alpha');

    const second = await inSession('Read', { file_path: path });
    expect(second.content[0].text).toBe(STUB);
    expect(second.details).toMatchObject({ ok: true, tool: 'Read', contentHash: first.details?.contentHash });
  });

  it('sends the full page when the requested range differs from the last one', async () => {
    const path = fixture('ranges.txt', 'one\ntwo\nthree\nfour\n');
    await inSession('Read', { file_path: path, offset: 1, limit: 2 });

    const wider = await inSession('Read', { file_path: path, offset: 1, limit: 3 });
    expect(wider.content[0].text).toContain('three');

    const moved = await inSession('Read', { file_path: path, offset: 2, limit: 3 });
    expect(moved.content[0].text).toContain('four');

    // …and the whole file is a different range again, even though it contains the page just shown.
    const whole = await inSession('Read', { file_path: path });
    expect(whole.content[0].text).toContain('one');
  });

  it('dedups the same page twice, notice and all', async () => {
    const path = fixture('paged.txt', 'one\ntwo\nthree\nfour\n');
    const first = await inSession('Read', { file_path: path, offset: 1, limit: 2 });
    expect(first.content[0].text).toContain('Showing lines 1-2 of 4');

    const second = await inSession('Read', { file_path: path, offset: 1, limit: 2 });
    expect(second.content[0].text).toBe(STUB);
    expect(second.details).toMatchObject({ truncated: true });
  });

  it('sends the full content again once the file has changed on disk', async () => {
    const path = fixture('changed.txt', 'alpha\n');
    await inSession('Read', { file_path: path });
    writeFileSync(path, 'alpha\ngamma\n');

    const res = await inSession('Read', { file_path: path });
    expect(res.content[0].text).toContain('gamma');
  });

  // A Write/Edit result carries a diff, not the file, so its baseline must never stand in for content the
  // model was never shown. What says so is the recorded RANGE, which only a text Read writes.
  it('never stubs against a Write baseline, and dedups again once a Read has shown the file', async () => {
    const path = join(dir, `${n}-authored.txt`);
    expect((await inSession('Write', { file_path: path, content: 'alpha\nbeta\n' })).content[0].text).toContain('Wrote');

    const first = await inSession('Read', { file_path: path });
    expect(first.content[0].text).toContain('alpha');
    expect((await inSession('Read', { file_path: path })).content[0].text).toBe(STUB);
  });

  it('sends full content after our own Edit — the bytes it reported are not the bytes on disk', async () => {
    const path = fixture('edited.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    expect((await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'ALPHA' })).details)
      .toMatchObject({ ok: true });

    const after = await inSession('Read', { file_path: path });
    expect(after.content[0].text).toContain('ALPHA');
  });

  // The stub is text. Returning it for an image, a PDF or a notebook would silently drop the attachment the
  // model actually needs, so those branches record no range and can never match.
  it('never stubs an image read', async () => {
    const path = join(dir, `${n}-pic.png`);
    writeFileSync(path, Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
      + '01f15c4890000000a49444154789c6300010000050001', 'hex'));
    await inSession('Read', { file_path: path });

    const second = await inSession('Read', { file_path: path });
    expect(second.content[0].text).not.toBe(STUB);
    expect(second.content).toContainEqual(expect.objectContaining({ type: 'image' }));
  });

  it('lets a stub authorize a mutation exactly as the read it stands in for would', async () => {
    const path = fixture('stub-then-edit.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    expect((await inSession('Read', { file_path: path })).content[0].text).toBe(STUB);

    const edit = await inSession('Edit', { file_path: path, old_string: 'beta', new_string: 'BETA' });
    expect(edit.content[0].text).toContain('Edited');
    expect(readFileSync(path, 'utf-8')).toBe('alpha\nBETA\n');
  });

  it('does not stub against a read replayed from history — the range is not in the transcript', async () => {
    const path = fixture('replayed.txt', 'alpha\nbeta\n');
    const read = await inSession('Read', { file_path: path });
    const revived = `${session}-revived`;
    await afterSpawn(revived, [{ role: 'toolResult', details: read.details }]);

    const res = await inSession('Read', { file_path: path }, revived);
    expect(res.content[0].text).toContain('alpha');

    // The seeded entry still authorizes, which is what the replay is for.
    const write = await inSession('Write', { file_path: path, content: 'rewritten\n' }, revived);
    expect(write.content[0].text).toContain('Wrote');
  });

  // A stub carries the same details as the read it replaces, so replaying it after a restart authorizes
  // exactly as that read would. A stub that vouched for less would make a conversation forget a file it can
  // still see, purely because the last mention of it was short.
  it('replays a stub result as the read it stands in for', async () => {
    const path = fixture('replayed-stub.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    const stub = await inSession('Read', { file_path: path });
    expect(stub.content[0].text).toBe(STUB);

    const revived = `${session}-revived-stub`;
    await afterSpawn(revived, [{ role: 'toolResult', details: stub.details }]);

    const write = await inSession('Write', { file_path: path, content: 'rewritten\n' }, revived);
    expect(write.content[0].text).toContain('Wrote');
  });

  // Eviction is least-recently-USED, and a stub IS a use: a conversation whose reads are all answered from
  // the stub would otherwise look idle and be evicted out from under an agent still working on that file.
  it('keeps a conversation alive through reads answered by the stub', async () => {
    const path = fixture('long-lived.txt', 'body\n');
    const mine = `${session}-long-lived`;
    await inSession('Read', { file_path: path }, mine);

    const churn = async (from: number, to: number) => {
      for (let i = from; i < to; i += 1) {
        const other = join(dir, `${n}-churn-${i}.txt`);
        writeFileSync(other, 'x');
        await inSession('Read', { file_path: other }, `brain-dedup-churn-${n}-${i}`);
      }
    };

    await churn(0, 63); // the cap is 64 sessions, so this alone must not evict `mine`…
    expect((await inSession('Read', { file_path: path }, mine)).content[0].text).toBe(STUB);
    await churn(63, 100);

    const res = await inSession('Edit', { file_path: path, old_string: 'body', new_string: 'BODY' }, mine);
    expect(res.content[0].text).toContain('Edited');
  });

  it('does not let one conversation stub on another conversation\'s read', async () => {
    const path = fixture('cross-session.txt', 'alpha\n');
    await inSession('Read', { file_path: path }, `${session}-other`);

    const res = await inSession('Read', { file_path: path });
    expect(res.content[0].text).toContain('alpha');
  });
});
