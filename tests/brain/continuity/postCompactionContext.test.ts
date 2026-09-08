import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPostCompactionContext, drainPostCompactionContext, type PostCompactionStore } from '../../../src/brain/continuity/postCompactionContext.js';
import { seedPlan } from '../../helpers/plan.js';

describe('continuity/postCompactionContext', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-postcompact-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** A store holding just the rows a test cares about. */
  const storeWith = (...rows: { role: string; content: unknown }[]): PostCompactionStore => ({
    getMessages: () => rows.map((r, index) => ({ id: `m${index}`, role: r.role, content: JSON.stringify(r.content) })),
  });
  const divider = (workingSet: unknown) => ({ role: 'compaction', content: { role: 'compactionSummary', workingSet } });
  const empty = storeWith();

  it('says nothing when there is neither a plan nor a working set', async () => {
    expect(await buildPostCompactionContext(empty, 's1', [])).toBe('');
  });

  it('carries the plan alone', async () => {
    seedPlan('s1', '# Ship it');
    const out = await buildPostCompactionContext(empty, 's1', []);
    expect(out).toContain('>\n# Ship it\n</active-plan>');
    expect(out).not.toContain('<working-set>');
  });

  it('carries the working set alone, labelling reads and edits', async () => {
    const store = storeWith(divider([{ path: '/a.ts', wrote: true }, { path: '/b.ts', wrote: false }]));
    const out = await buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('- /a.ts (edited)');
    expect(out).toContain('- /b.ts (read)');
    expect(out).not.toContain('<active-plan file=');
  });

  it('carries both in one reminder', async () => {
    seedPlan('s1', '# Ship it');
    const store = storeWith(divider([{ path: '/a.ts', wrote: true }]));
    const out = await buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('<active-plan file=');
    expect(out).toContain('<working-set>');
    expect(out.startsWith('<system-reminder>')).toBe(true);
    expect(out.endsWith('</system-reminder>')).toBe(true);
  });

  // A compaction that kept the turn holding the plan cost the model nothing — repeating the document
  // would spend the very context the compaction reclaimed.
  it('omits a plan the model can still see in the live context', async () => {
    seedPlan('s1', '# Ship it');
    const live = [{ role: 'assistant', content: 'here it is <proposed_plan>\n# Ship it\n</proposed_plan>' }];
    expect(await buildPostCompactionContext(empty, 's1', live)).toBe('');
  });

  it('still carries the working set when the plan is suppressed', async () => {
    seedPlan('s1', '# Ship it');
    const store = storeWith(divider([{ path: '/a.ts', wrote: false }]));
    const live = [{ role: 'assistant', content: '<proposed_plan>\n# Ship it\n</proposed_plan>' }];
    const out = await buildPostCompactionContext(store, 's1', live);
    expect(out).not.toContain('<active-plan file=');
    expect(out).toContain('- /a.ts (read)');
  });

  // Repeated compactions: orient around the most recent loss, not the first.
  it('reads the working set of the newest divider', async () => {
    const store = storeWith(divider([{ path: '/old.ts', wrote: false }]), divider([{ path: '/new.ts', wrote: false }]));
    const out = await buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('/new.ts');
    expect(out).not.toContain('/old.ts');
  });

  it('tolerates a divider with no working set, an unparseable one, and a malformed list', async () => {
    expect(await buildPostCompactionContext(storeWith({ role: 'compaction', content: { role: 'compactionSummary' } }), 's1', [])).toBe('');
    expect(await buildPostCompactionContext({ getMessages: () => [{ id: 'm0', role: 'compaction', content: '{oops' }] }, 's1', [])).toBe('');
    expect(await buildPostCompactionContext(storeWith(divider('not-a-list')), 's1', [])).toBe('');
    expect(await buildPostCompactionContext(storeWith(divider([{ nope: 1 }])), 's1', [])).toBe('');
  });

  it('tells the model not to trust the summary about file contents', async () => {
    seedPlan('s1', 'x');
    expect(await buildPostCompactionContext(empty, 's1', [])).toContain('do not assume file contents from the summary');
  });

  // The plan-mode directive QUOTES the `<proposed_plan>` tag when it tells the model how to answer, and
  // that directive rides in a live message. A tag-based visibility check therefore reads every plan-mode
  // session as "the plan is still on screen" and suppresses re-injection in exactly the mode this whole
  // feature exists to protect.
  describe('deciding whether the plan is still visible', () => {
    const directive = 'Plan mode is STILL ACTIVE — end the turn with exactly one `<proposed_plan>` block.';
    const msg = (content: string) => ({ role: 'user', content });

    it('re-injects the plan when only the mode directive mentions the tag', async () => {
      seedPlan('s1', '# Ship it\n\n1. Wire the store');
      const out = await buildPostCompactionContext(empty, 's1', [msg(directive)]);
      expect(out).toContain('<active-plan file=');
      expect(out).toContain('Wire the store');
    });

    it('stays quiet when the plan text itself is still on screen', async () => {
      seedPlan('s1', '# Ship it\n\n1. Wire the store');
      expect(await buildPostCompactionContext(empty, 's1', [msg('# Ship it\n\n1. Wire the store')])).toBe('');
    });
  });

  describe('drain', () => {
    const live = () => ({ sessionId: 's1', session: { messages: [] as unknown[] } } as
      { sessionId: string; orientedForCompaction?: string; session: { messages: unknown[] } });
    const withDivider = (id: string, workingSet?: unknown): PostCompactionStore => ({
      getMessages: () => [
        { id: 'u1', role: 'user', content: JSON.stringify({ role: 'user', content: 'hi' }) },
        { id, role: 'compaction', content: JSON.stringify({ role: 'compactionSummary', ...(workingSet ? { workingSet } : {}) }) },
      ],
    });

    it('stays silent when the conversation never compacted', async () => {
      seedPlan('s1', '# Ship it');
      expect(await drainPostCompactionContext(empty, live())).toMatchObject({ block: '', compacted: false });
    });

    // One-shot per compaction: the model is oriented once, not reminded every turn for the rest of it.
    it('yields the block once and then goes quiet', async () => {
      seedPlan('s1', '# Ship it');
      const store = withDivider('div-1');
      const l = live();
      const first = await drainPostCompactionContext(store, l);
      expect(first.block).toContain('<active-plan file=');
      first.commit();
      expect(l.orientedForCompaction).toBe('div-1');
      expect(await drainPostCompactionContext(store, l)).toMatchObject({ block: '', compacted: false });
    });

    // The marker is recorded even when there was nothing worth saying, so the same compaction cannot
    // resurface later — and a SECOND compaction still gets its own orientation.
    it('records the divider even with nothing to report, and re-orients on a newer one', async () => {
      const l = live();
      const first = await drainPostCompactionContext(withDivider('div-1'), l);
      expect(first.block).toBe('');
      first.commit();
      expect(l.orientedForCompaction).toBe('div-1');
      seedPlan('s1', '# Ship it');
      const second = await drainPostCompactionContext(withDivider('div-2'), l);
      expect(second.block).toContain('<active-plan file=');
      second.commit();
      expect(l.orientedForCompaction).toBe('div-2');
    });

    // The distinction the caller depends on: a QUIET compaction reports nothing to say but must still
    // report that it happened, because it deleted every standing instruction along with everything else.
    it('reports a compaction it has nothing to say about', async () => {
      expect(await drainPostCompactionContext(withDivider('div-1'), live()))
        .toMatchObject({ block: '', compacted: true });
    });

    // Consuming the orientation at COMPOSITION time looked equivalent and was not: a provider error or an
    // abort between building the prompt and sending it threw the re-orientation away for good, on a turn
    // that never happened. That window is common exactly when it hurts, since compaction follows a heavy
    // turn. Erring the other way costs at most one duplicate reminder.
    it('keeps the orientation pending until the caller commits', async () => {
      seedPlan('s1', '# Ship it');
      const store = withDivider('div-1');
      const l = live();
      expect((await drainPostCompactionContext(store, l)).block).toContain('<active-plan file=');
      expect(l.orientedForCompaction).toBeUndefined();
      // The turn failed, so the next one must still be oriented.
      expect((await drainPostCompactionContext(store, l)).block).toContain('<active-plan file=');
    });
  });
});
