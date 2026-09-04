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

interface ToolResult { content: { text?: string }[]; details?: Record<string, unknown> }
const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>, executionContext?: unknown) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as {
    execute: (id: string, p: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) => Promise<ToolResult>;
  }).execute('t', params, undefined, undefined, executionContext);
};

// Editing a file the conversation never read is how content silently disappears: the model writes from
// assumption instead of from what is on disk. The guard makes that impossible without blocking any
// legitimate flow.
describe('files plugin — read-before-modify guard', () => {
  let reg: PluginRegistry;
  let dir: string;
  let n = 0;

  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-guard-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  // A fresh session id per test: the guard's state is per conversation, so tests must not vouch for one
  // another's reads.
  let session: string;
  beforeEach(() => { n += 1; session = `brain-guard-${n}`; });

  const inSession = (name: string, params: Record<string, unknown>, sid = session) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { sessionId: sid });

  const fixture = (name: string, body: string) => {
    const path = join(dir, `${n}-${name}`);
    writeFileSync(path, body);
    return path;
  };

  it('refuses to edit a file this conversation has not read', async () => {
    const path = fixture('unread.txt', 'alpha\nbeta\n');
    const res = await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'ALPHA' });

    expect(res.content[0].text).toMatch(/has not been read in this conversation/);
    expect(res.details).toMatchObject({ ok: false });
    expect(readFileSync(path, 'utf-8')).toBe('alpha\nbeta\n'); // untouched
  });

  it('refuses to overwrite an existing file this conversation has not read', async () => {
    const path = fixture('unread-write.txt', 'precious\n');
    const res = await inSession('Write', { file_path: path, content: 'clobbered' });

    expect(res.content[0].text).toMatch(/has not been read in this conversation/);
    expect(readFileSync(path, 'utf-8')).toBe('precious\n'); // the whole point: nothing was lost
  });

  it('allows the edit once the file has been read', async () => {
    const path = fixture('read-then-edit.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    const res = await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'ALPHA' });

    expect(res.content[0].text).toContain('Edited');
    expect(readFileSync(path, 'utf-8')).toBe('ALPHA\nbeta\n');
  });

  it('always allows creating a brand-new file — there is nothing there to lose', async () => {
    const path = join(dir, `${n}-brand-new.txt`);
    const res = await inSession('Write', { file_path: path, content: 'fresh' });

    expect(res.content[0].text).toContain('Wrote');
    expect(readFileSync(path, 'utf-8')).toBe('fresh');
  });

  it('lets consecutive edits proceed without a re-read — our own write updates what we know', async () => {
    const path = fixture('consecutive.txt', 'one\ntwo\nthree\n');
    await inSession('Read', { file_path: path });
    expect((await inSession('Edit', { file_path: path, old_string: 'one', new_string: '1' })).content[0].text).toContain('Edited');
    expect((await inSession('Edit', { file_path: path, old_string: 'two', new_string: '2' })).content[0].text).toContain('Edited');
    expect((await inSession('Write', { file_path: path, content: 'rewritten' })).content[0].text).toContain('Wrote');
    expect(readFileSync(path, 'utf-8')).toBe('rewritten');
  });

  it('refuses to overwrite a file that changed on disk behind the agent, and allows it after a re-read', async () => {
    const path = fixture('stale.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    writeFileSync(path, 'alpha\nbeta\nimportant new line\n'); // someone else wrote to it

    const stale = await inSession('Write', { file_path: path, content: 'alpha only' });
    expect(stale.content[0].text).toMatch(/has changed on disk since you last read it/);
    expect(readFileSync(path, 'utf-8')).toContain('important new line'); // not clobbered

    await inSession('Read', { file_path: path }); // the agent catches up…
    const ok = await inSession('Write', { file_path: path, content: 'now informed' });
    expect(ok.content[0].text).toContain('Wrote');                      // …and may now proceed
  });

  it('refuses to edit a file that changed on disk after the agent merely READ it', async () => {
    const path = fixture('stale-edit.txt', 'alpha\nbeta\n');
    await inSession('Read', { file_path: path });
    writeFileSync(path, 'alpha\nbeta\nsomeone else was here\n');

    const res = await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'ALPHA' });
    expect(res.content[0].text).toMatch(/has changed on disk since you last read it/);
    expect(readFileSync(path, 'utf-8')).toContain('someone else was here');
  });

  // The formatters plugin rewrites a file from a tools.call.after hook, AFTER Write returns, and gives
  // us no signal that it did. We cannot tell its rewrite from an outsider's, so the two mutations are held
  // to different bars — see the guard's note. This pins BOTH halves of that contract.
  describe('after our own write is reshaped by the formatter hook', () => {
    it('a targeted edit still applies — its old_string anchor must match the current bytes anyway', async () => {
      const path = fixture('formatted-edit.txt', 'x\n');
      await inSession('Read', { file_path: path });
      await inSession('Write', { file_path: path, content: 'const a=1' });
      writeFileSync(path, 'const a = 1;\n'); // the formatter reshapes what we just wrote

      const res = await inSession('Edit', { file_path: path, old_string: 'const a = 1;', new_string: 'const b = 2;' });
      expect(res.content[0].text).toContain('Edited');  // not blocked by our own formatter
      expect(readFileSync(path, 'utf-8')).toBe('const b = 2;\n');
    });

    it('a stale old_string is still rejected — the pass is on the guard, never on the match', async () => {
      const path = fixture('formatted-mismatch.txt', 'x\n');
      await inSession('Read', { file_path: path });
      await inSession('Write', { file_path: path, content: 'const a=1' });
      writeFileSync(path, 'const a = 1;\n');

      // The agent edits against what it THINKS it wrote (unformatted). That anchor no longer exists.
      const res = await inSession('Edit', { file_path: path, old_string: 'const a=1', new_string: 'const b=2' });
      expect(res.content[0].text).toMatch(/old_string not found/);
      expect(readFileSync(path, 'utf-8')).toBe('const a = 1;\n'); // unchanged
    });

    it('a blind full overwrite is refused — it would discard bytes the agent never saw', async () => {
      const path = fixture('formatted-write.txt', 'x\n');
      await inSession('Read', { file_path: path });
      await inSession('Write', { file_path: path, content: 'const a=1' });
      writeFileSync(path, 'const a = 1;\n');

      const res = await inSession('Write', { file_path: path, content: 'const b=2' });
      expect(res.content[0].text).toMatch(/has changed on disk since you last read it/);
      expect(readFileSync(path, 'utf-8')).toBe('const a = 1;\n');
    });

    // The guard DECIDES; only a mutation that lands RECORDS. If a failed edit re-baselined the divergent
    // bytes, it would bless content the agent never saw and the blind overwrite above would sail through.
    it('an edit that FAILS does not bless the bytes it never applied to', async () => {
      const path = fixture('failed-edit.txt', 'x\n');
      await inSession('Read', { file_path: path });
      await inSession('Write', { file_path: path, content: 'const a=1' });
      writeFileSync(path, 'const a = 1;\n'); // formatter reshapes it

      // The edit is allowed past the guard, then fails on its own anchor — the agent still has not seen
      // the current bytes.
      const failed = await inSession('Edit', { file_path: path, old_string: 'nothing like this', new_string: 'x' });
      expect(failed.content[0].text).toMatch(/old_string not found/);

      // …so a blind overwrite must STILL be refused.
      const blind = await inSession('Write', { file_path: path, content: 'clobber' });
      expect(blind.content[0].text).toMatch(/has changed on disk since you last read it/);
      expect(readFileSync(path, 'utf-8')).toBe('const a = 1;\n');
    });
  });

  it('a text Read error does not count as having read the file', async () => {
    const path = fixture('invalid-read.txt', 'precious\n');
    const read = await inSession('Read', { file_path: path, offset: -1 });
    expect(read.details).toMatchObject({ ok: false });

    const write = await inSession('Write', { file_path: path, content: 'clobber' });
    expect(write.content[0].text).toMatch(/has not been read in this conversation/);
    expect(readFileSync(path, 'utf-8')).toBe('precious\n');
  });

  it('a truncated text Read does not authorize a full-file Write', async () => {
    const path = fixture('partial-write.txt', 'one\ntwo\nthree\nfour\n');
    const read = await inSession('Read', { file_path: path, limit: 2 });
    expect(read.details).toMatchObject({ ok: true, truncated: true });

    const write = await inSession('Write', { file_path: path, content: 'clobber' });
    expect(write.content[0].text).toMatch(/not been fully read/i);
    expect(readFileSync(path, 'utf-8')).toBe('one\ntwo\nthree\nfour\n');
  });

  it('paged text Reads authorize Edit only after their visible coverage is complete', async () => {
    const path = fixture('paged-edit.txt', 'one\ntwo\nthree\nfour\n');
    await inSession('Read', { file_path: path, offset: 1, limit: 2 });
    const partial = await inSession('Edit', { file_path: path, old_string: 'four', new_string: 'FOUR' });
    expect(partial.content[0].text).toMatch(/not been fully read/i);

    await inSession('Read', { file_path: path, offset: 3, limit: 2 });
    const complete = await inSession('Edit', { file_path: path, old_string: 'four', new_string: 'FOUR' });
    expect(complete.content[0].text).toContain('Edited');
    expect(readFileSync(path, 'utf-8')).toBe('one\ntwo\nthree\nFOUR\n');
  });

  it('an image omitted from the model request does not count as having read the file', async () => {
    const path = join(dir, `${n}-omitted.png`);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64');
    writeFileSync(path, png);

    const read = await runWithPolicy(userPolicy([dir]), () => runTool(
      reg, 'Read', { file_path: path }, { model: { input: ['text'] } },
    ), { sessionId: session });
    expect(read.content[0].text).toContain('does not support images');
    expect(read.content).not.toContainEqual(expect.objectContaining({ type: 'image' }));

    const write = await inSession('Write', { file_path: path, content: 'clobber' });
    expect(write.content[0].text).toMatch(/has not been read in this conversation/);
    expect(readFileSync(path)).toEqual(png);
  });

  it('an image-only notebook omitted for a text-only model does not authorize Write', async () => {
    const path = fixture('image-only.ipynb', JSON.stringify({
      cells: [{
        cell_type: 'code', source: [], execution_count: 1,
        outputs: [{ output_type: 'display_data', data: {
          'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
        } }],
      }],
    }));
    const read = await runWithPolicy(userPolicy([dir]), () => runTool(
      reg, 'Read', { file_path: path }, { model: { input: ['text'] } },
    ), { sessionId: session });
    expect(read.details).toMatchObject({ ok: true, truncated: true });
    expect(read.content).not.toContainEqual(expect.objectContaining({ type: 'image' }));

    const write = await inSession('Write', { file_path: path, content: 'clobber' });
    expect(write.content[0].text).toMatch(/not been fully read|has not been read/i);
    expect(readFileSync(path, 'utf-8')).toContain('image/png');
  });

  it('a PDF read that FAILED does not count as having read the file', async () => {
    // Marking a failed read as "seen" would license a later Write over a document nobody ever saw.
    const pdf = join(dir, `${n}-broken.pdf`);
    writeFileSync(pdf, '%PDF-1.4\nnot really a pdf\n');
    const read = await inSession('Read', { file_path: pdf, pages: '1' });
    expect(read.details).toMatchObject({ ok: false });

    const write = await inSession('Write', { file_path: pdf, content: 'clobber' });
    expect(write.content[0].text).toMatch(/has not been read in this conversation/);
    expect(readFileSync(pdf, 'utf-8')).toContain('not really a pdf');
  });

  it('evicting many other conversations does not drop the one still in use', async () => {
    // Eviction is least-recently-USED. Creation order would throw away the operator's long-running CLI
    // conversation as soon as 64 short-lived sub-agent/cron sessions had come and gone.
    const path = fixture('long-lived.txt', 'body\n');
    const mine = `brain-long-lived-${n}`;
    await inSession('Read', { file_path: path }, mine);

    // 63 other conversations churn through (the cap is 64, so this must not evict `mine`)…
    for (let i = 0; i < 63; i += 1) {
      const other = join(dir, `${n}-churn-${i}.txt`);
      writeFileSync(other, 'x');
      await inSession('Read', { file_path: other }, `brain-churn-${n}-${i}`);
    }
    // …and `mine` was touched most recently of all the survivors only because it is still in use:
    await inSession('Read', { file_path: path }, mine);
    for (let i = 63; i < 100; i += 1) {
      const other = join(dir, `${n}-churn-${i}.txt`);
      writeFileSync(other, 'x');
      await inSession('Read', { file_path: other }, `brain-churn-${n}-${i}`);
    }

    const res = await inSession('Edit', { file_path: path, old_string: 'body', new_string: 'BODY' }, mine);
    expect(res.content[0].text).toContain('Edited');
  });

  it('does not let one conversation vouch for another — a sub-agent read is not the parent\'s read', async () => {
    const path = fixture('cross-session.txt', 'shared\n');
    await inSession('Read', { file_path: path }, 'brain-other-session');

    const res = await inSession('Edit', { file_path: path, old_string: 'shared', new_string: 'stolen' });
    expect(res.content[0].text).toMatch(/has not been read in this conversation/);
    expect(readFileSync(path, 'utf-8')).toBe('shared\n');
  });

  it('is inert outside a conversation — no session to key on means no false refusal', async () => {
    const path = fixture('no-session.txt', 'body\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: path, old_string: 'body', new_string: 'BODY' }));
    expect(res.content[0].text).toContain('Edited');
  });

  // Elowen auto-updates, so a daemon restart mid-conversation is routine — and the guard's state is
  // process memory while the conversation is not. Reopening one used to make the guard insist the agent
  // had never seen a file it read three messages ago and still has in its context. The transcript is
  // replayed into the state at spawn; a session id this process has never seen IS the post-restart state.
  describe('across a restart', () => {
    const afterSpawn = (sid: string, messages: unknown[]) =>
      new PluginHookBus({ hooks: reg.hooks }).emit('brain.session.afterSpawn', { sessionId: sid, messages });
    const toolResult = (details: unknown) => ({ role: 'toolResult', details });

    it('a read replayed from history spares the agent a second read of an unchanged file', async () => {
      const path = fixture('restart.txt', 'alpha\nbeta\n');
      const read = await inSession('Read', { file_path: path });
      expect(read.details?.contentHash).toEqual(expect.any(String));

      const revived = `${session}-revived`;
      await afterSpawn(revived, [toolResult(read.details)]);

      const res = await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'ALPHA' }, revived);
      expect(res.details).toMatchObject({ ok: true });
      expect(readFileSync(path, 'utf-8')).toBe('ALPHA\nbeta\n');
    });

    it('still refuses when the file moved while the daemon was down', async () => {
      const path = fixture('restart-changed.txt', 'alpha\n');
      const read = await inSession('Read', { file_path: path });
      writeFileSync(path, 'someone else wrote this\n'); // the window the guard exists for
      const revived = `${session}-revived`;
      await afterSpawn(revived, [toolResult(read.details)]);

      const res = await inSession('Edit', { file_path: path, old_string: 'someone', new_string: 'X' }, revived);
      expect(res.content[0].text).toMatch(/has changed on disk since you last read it/);
      expect(readFileSync(path, 'utf-8')).toBe('someone else wrote this\n');
    });

    // The point of seeding from the transcript rather than a persisted map: the guard and the model's
    // actual knowledge move together. A read the model can no longer see vouches for nothing.
    it('does not vouch for a read that compaction dropped from the context', async () => {
      const path = fixture('restart-compacted.txt', 'alpha\n');
      await inSession('Read', { file_path: path });
      await afterSpawn(session, []);

      const res = await inSession('Edit', { file_path: path, old_string: 'alpha', new_string: 'X' });
      expect(res.content[0].text).toMatch(/has not been read in this conversation/);
    });

    it('atomically replaces stale session state with only visible successful full Read results', async () => {
      const removed = fixture('restart-removed.txt', 'removed\n');
      const visible = fixture('restart-visible.txt', 'visible\n');
      const authoredPath = join(dir, `${n}-authored.txt`);
      await inSession('Read', { file_path: removed });
      const visibleRead = await inSession('Read', { file_path: visible }, `${session}-source`);
      const authored = await inSession('Write', { file_path: authoredPath, content: 'authored\n' }, `${session}-source`);

      await afterSpawn(session, [toolResult(authored.details), toolResult(visibleRead.details)]);

      expect((await inSession('Write', { file_path: removed, content: 'clobber' })).content[0].text)
        .toMatch(/has not been read in this conversation/);
      expect((await inSession('Write', { file_path: authoredPath, content: 'clobber' })).content[0].text)
        .toMatch(/has not been read in this conversation/);
      expect((await inSession('Edit', { file_path: visible, old_string: 'visible', new_string: 'VISIBLE' })).content[0].text)
        .toContain('Edited');
    });

    it('does not replay Write results as a full-file read baseline', async () => {
      const path = join(dir, `${n}-restart-authored.txt`);
      const write = await inSession('Write', { file_path: path, content: 'one\ntwo\n' });
      writeFileSync(path, 'one\ntwo\n\n');
      const revived = `${session}-revived`;
      await afterSpawn(revived, [toolResult(write.details)]);

      const res = await inSession('Edit', { file_path: path, old_string: 'two', new_string: 'TWO' }, revived);
      expect(res.content[0].text).toMatch(/has not been read in this conversation/);
    });

    it('replays in order, so the newest result for a file is the one that counts', async () => {
      const path = fixture('restart-order.txt', 'v1\n');
      const stale = await inSession('Read', { file_path: path });
      writeFileSync(path, 'v2\n');
      const fresh = await inSession('Read', { file_path: path });
      const revived = `${session}-revived`;
      await afterSpawn(revived, [toolResult(stale.details), toolResult(fresh.details)]);

      const res = await inSession('Edit', { file_path: path, old_string: 'v2', new_string: 'V2' }, revived);
      expect(res.details).toMatchObject({ ok: true });
    });
  });

  it('a read of the PDF or the image branch also counts as having read the file', async () => {
    // The guard tracks bytes on disk, so every read path must record — otherwise a read that happens to
    // take a different branch would leave a later edit inexplicably refused.
    const png = join(dir, `${n}-pic.png`);
    // 1x1 PNG.
    writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
      + '01f15c4890000000a49444154789c6300010000050001', 'hex'));
    await inSession('Read', { file_path: png });
    const res = await inSession('Write', { file_path: png, content: 'replaced by text' });
    expect(res.content[0].text).toContain('Wrote');
  });
});
