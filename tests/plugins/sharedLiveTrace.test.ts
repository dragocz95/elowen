import { describe, it, expect } from 'vitest';
import {
  // @ts-expect-error — plain .mjs plugin module, no types
  sanitizeControl, makeTextHelpers, outputFailed, makeOutputSummary, diffSummary, makeFoldedCalls, makeToolLinesFor, makeCardLines,
} from '../../packages/plugin-shared/liveTrace.mjs';

const DISCORD = {
  mentionSafe: (s: string) => s.replace(/@(?=everyone|here)/gi, '@​').replace(/<@(?=[!&]?\d)/g, '<@​'),
  fenceSafe: (s: string) => s.replace(/```/g, "'''"),
  bold: (s: string) => `**${s}**`,
  strike: (s: string) => `~~${s}~~`,
  summaryLine: (s: string) => `-# ↳ ${s}`,
};
const PLAIN = { mentionSafe: (s: string) => s, fenceSafe: (s: string) => s, bold: (s: string) => s, strike: (s: string) => s, summaryLine: (s: string) => `  ↳ ${s}` };

describe('shared liveTrace text helpers', () => {
  it('sanitizeControl strips ANSI escapes and control characters', () => {
    expect(sanitizeControl('[31mred[0mok')).toBe('redok');
    expect(sanitizeControl(null)).toBe('');
  });

  it('Discord style hardens mentions and fences; the plain style leaves them alone', () => {
    const d = makeTextHelpers(DISCORD);
    expect(d.compactLine('ping @everyone now')).toBe('ping @​everyone now');
    expect(d.safeTail('```js\ncode\n```')).toContain("'''");
    const p = makeTextHelpers(PLAIN);
    expect(p.compactLine('ping @everyone now')).toBe('ping @everyone now');
    expect(p.safeTail('```js\ncode\n```')).toContain('```');
  });

  it('compactLine collapses whitespace and truncates with an ellipsis', () => {
    const { compactLine } = makeTextHelpers(PLAIN);
    expect(compactLine('a\n  b\t c')).toBe('a b c');
    expect(compactLine('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

describe('shared liveTrace output/diff summaries', () => {
  const { compactLine, safeTail } = makeTextHelpers(PLAIN);
  const outputSummary = makeOutputSummary({ compactLine, safeTail });

  it('outputFailed reads the structured tone, not status strings', () => {
    expect(outputFailed({ tone: 'warning' })).toBe(true);
    expect(outputFailed({ tone: 'danger', status: 'exit 1' })).toBe(true);
    expect(outputFailed({ tone: 'success' })).toBe(false);
    expect(outputFailed(undefined)).toBe(false);
  });

  it('outputSummary prefers a note, then a FAILURE status, then the last text line', () => {
    expect(outputSummary({ notes: ['done well'], tone: 'success', text: 'x' })).toBe('done well');
    expect(outputSummary({ status: 'needs attention', tone: 'warning', text: 'x' })).toBe('needs attention');
    expect(outputSummary({ tone: 'success', text: 'line1\nlast line' })).toBe('last line');
  });

  it('a clean console success never surfaces exit-status noise (the Discord "[exit 0]" regression)', () => {
    // Exactly what toolOutputView produces for a successful Bash after the framing strip: success tone,
    // NO status, structured cwd, body = real output only.
    const success = {
      title: 'console output', kind: 'console', tone: 'success', cwd: '/var/www/elowen',
      text: 'total 12\n-rw-r--r-- 1 root root 55 letsencrypt.log',
    };
    const summary = outputSummary(success);
    expect(summary).toBe('-rw-r--r-- 1 root root 55 letsencrypt.log');
    expect(summary).not.toMatch(/exit\s*0/i);
    expect(outputFailed(success)).toBe(false);
  });

  it('a FAILING console run still surfaces its exit code as the summary', () => {
    const failed = { title: 'console output', kind: 'console', tone: 'warning', status: 'exit 3', text: 'boom: something broke' };
    expect(outputFailed(failed)).toBe(true);
    expect(outputSummary(failed)).toBe('exit 3');
  });

  it('diffSummary counts added/removed lines', () => {
    expect(diffSummary('+++ a\n+new\n--- b\n-old\n-old2')).toBe('+1 −2');
    expect(diffSummary('')).toBe('updated');
  });
});

describe('shared liveTrace fold rule (mirrors src/brain/transcript.ts groupToolItems)', () => {
  const { compactLine } = makeTextHelpers(PLAIN);
  const foldedCalls = makeFoldedCalls(compactLine);
  const display = { toolActivity: 'status', toolOutput: 'summary' };

  it('folds consecutive bare calls of the same tool into one counted row', () => {
    const rows = foldedCalls([
      { name: 'Read', state: 'done' }, { name: 'Read', state: 'done' }, { name: 'Read', state: 'done' },
    ], display);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('keeps a row that speaks (has a summary) separate', () => {
    const rows = foldedCalls([
      { name: 'Bash', state: 'done', summary: 'ran tests' }, { name: 'Bash', state: 'done' },
    ], display);
    expect(rows).toHaveLength(2);
  });

  it('folds a run of the SAME failure but keeps genuinely different failures apart', () => {
    const same = foldedCalls([
      { name: 'Read', state: 'error', summary: 'no file /a/b.ts' }, { name: 'Read', state: 'error', summary: 'no file /c/d.ts' },
    ], display);
    expect(same).toHaveLength(1);
    expect(same[0].count).toBe(2);
    const diff = foldedCalls([
      { name: 'Read', state: 'error', summary: 'permission denied' }, { name: 'Read', state: 'error', summary: 'no such file' },
    ], display);
    expect(diff).toHaveLength(2);
  });
});

describe('shared liveTrace row/card rendering per style', () => {
  const helpers = makeTextHelpers(DISCORD);
  const toolLinesFor = makeToolLinesFor({ ...helpers, style: DISCORD });

  it('renders the tool head row with detail, count and summary', () => {
    const [head] = toolLinesFor({ icon: '💻', name: 'Bash', detail: 'npm test', count: 2, summary: 'passed', state: 'done' }, { toolOutput: 'summary', toolActivity: 'status' });
    expect(head).toBe('💻 `Bash`: "npm test" ×2 — passed');
  });

  it('cardLines applies the surface emphasis (Discord bolds and strikes; plain does neither)', () => {
    const card = { title: 'Plan', items: [{ status: 'completed', text: 'a' }, { status: 'pending', text: 'b' }] };
    const dLines = makeCardLines(DISCORD)(card);
    expect(dLines[0]).toBe('📋 **Plan** (1/2)');
    expect(dLines[1]).toBe('✅ ~~a~~');
    const pLines = makeCardLines(PLAIN)(card);
    expect(pLines[0]).toBe('📋 Plan (1/2)');
    expect(pLines[1]).toBe('✅ a');
  });
});
