import { describe, it, expect } from 'vitest';
import { buildReviewContext, REVIEW_DIFF_LIMIT } from '../../../../plugins/agents/src/overseer/reviewContext.js';

describe('buildReviewContext', () => {
  it('carries the agent self-report and the real evidence (changed files + diff)', () => {
    const ctx = buildReviewContext({
      title: 'Add CSV export', outcome: 'ok', summary: 'done it',
      changedFiles: ['src/a.ts', 'src/b.ts'], diff: 'diff --git a/src/a.ts ...',
    });
    expect(ctx).toMatchObject({
      title: 'Add CSV export', outcome: 'ok', summary: 'done it',
      changedFiles: ['src/a.ts', 'src/b.ts'], diff: 'diff --git a/src/a.ts ...',
      diffTruncated: false,
    });
  });

  it('keeps a diff under the limit intact', () => {
    const diff = 'x'.repeat(REVIEW_DIFF_LIMIT);
    const ctx = buildReviewContext({ title: 't', outcome: 'ok', summary: 's', changedFiles: [], diff });
    expect(ctx.diff).toBe(diff);
    expect(ctx.diffTruncated).toBe(false);
  });

  it('truncates an oversized diff and flags it so the overseer knows to pull the rest via git', () => {
    const diff = 'x'.repeat(REVIEW_DIFF_LIMIT + 5000);
    const ctx = buildReviewContext({ title: 't', outcome: 'ok', summary: 's', changedFiles: [], diff });
    expect((ctx.diff as string).length).toBe(REVIEW_DIFF_LIMIT);
    expect(ctx.diffTruncated).toBe(true);
  });

  it('reports an empty diff plainly (no changes detected in the working tree)', () => {
    const ctx = buildReviewContext({ title: 't', outcome: 'ok', summary: 's', changedFiles: [], diff: '' });
    expect(ctx.diff).toBe('');
    expect(ctx.diffTruncated).toBe(false);
    expect(ctx.changedFiles).toEqual([]);
  });
});
