import { describe, it, expect } from 'vitest';
import { parseLogLines, filterLogLines, refreshScrollAction, type LogLevel } from '../../../modules/settings/logFilter';

const levels = (...v: LogLevel[]) => new Set<LogLevel>(v);
const none = new Set<LogLevel>();

const SAMPLE = [
  '2026-07-25 17:33:34.120  INFO   [brain-stop]  stop s1: last observer gone',
  '2026-07-25 17:33:34.124  ERROR  [deriver]  tick failed — Error: tmux down',
  '    at Object.<anonymous> (/var/www/elowen/src/x.ts:12:5)',
  '    at run (/var/www/elowen/src/y.ts:3:1)',
  '2026-07-25 17:33:35.001  WARN   [discord]  gateway reconnecting',
  '2026-07-25 17:33:36.002  DEBUG  [cron]  tick',
];

describe('parseLogLines', () => {
  it('reads the level and scope off each record and numbers lines from one', () => {
    const parsed = parseLogLines(SAMPLE);
    expect(parsed[0]).toMatchObject({ n: 1, level: 'info', scope: 'brain-stop' });
    expect(parsed[1]).toMatchObject({ n: 2, level: 'error', scope: 'deriver' });
    expect(parsed[4]).toMatchObject({ n: 5, level: 'warn', scope: 'discord' });
    expect(parsed[5]).toMatchObject({ n: 6, level: 'debug', scope: 'cron' });
  });

  it('lets a stack-trace continuation inherit the record it belongs to', () => {
    const parsed = parseLogLines(SAMPLE);
    expect(parsed[2]).toMatchObject({ n: 3, level: 'error', scope: 'deriver' });
    expect(parsed[3]).toMatchObject({ n: 4, level: 'error', scope: 'deriver' });
  });

  it('leaves a leading continuation unattributed rather than guessing', () => {
    const parsed = parseLogLines(['    at boot (/x.ts:1:1)', SAMPLE[0]]);
    expect(parsed[0]).toMatchObject({ n: 1, level: null, scope: null });
    expect(parsed[1]).toMatchObject({ n: 2, level: 'info' });
  });

  it('handles an empty file', () => {
    expect(parseLogLines([])).toEqual([]);
  });

  // Regression: the viewer is normally handed a TAIL (the API serves the last 2000 lines by default), so
  // numbering from 1 reported a position off by the whole dropped prefix — silently, and on the common
  // path. The gutter exists to be correlated against journalctl, so a confident wrong number is the worst
  // possible output.
  it('numbers a tail from its real position in the file, not from one', () => {
    const parsed = parseLogLines(SAMPLE, 7683);
    expect(parsed.map((l) => l.n)).toEqual([7683, 7684, 7685, 7686, 7687, 7688]);
  });

  it('keeps the real numbers through a filter, which is the whole point of the gutter', () => {
    const parsed = parseLogLines(SAMPLE, 7683);
    expect(filterLogLines(parsed, { query: '', levels: levels('error') }).map((l) => l.n)).toEqual([7684, 7685, 7686]);
  });

  it('defaults to one so a whole-file read still numbers from the top', () => {
    expect(parseLogLines(SAMPLE).map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('filterLogLines', () => {
  const parsed = parseLogLines(SAMPLE);

  it('returns everything when nothing is filtered', () => {
    expect(filterLogLines(parsed, { query: '', levels: none })).toHaveLength(SAMPLE.length);
  });

  it('keeps an error together with its whole stack', () => {
    const out = filterLogLines(parsed, { query: '', levels: levels('error') });
    expect(out.map((l) => l.n)).toEqual([2, 3, 4]);
  });

  it('preserves the ORIGINAL line numbers through a filter', () => {
    const out = filterLogLines(parsed, { query: '', levels: levels('warn', 'debug') });
    expect(out.map((l) => l.n)).toEqual([5, 6]);
  });

  it('matches the query case-insensitively anywhere in the line, including the scope', () => {
    expect(filterLogLines(parsed, { query: 'BRAIN-STOP', levels: none }).map((l) => l.n)).toEqual([1]);
    expect(filterLogLines(parsed, { query: 'tmux', levels: none }).map((l) => l.n)).toEqual([2]);
  });

  it('combines query and levels as AND', () => {
    expect(filterLogLines(parsed, { query: 'tick', levels: levels('debug') }).map((l) => l.n)).toEqual([6]);
    expect(filterLogLines(parsed, { query: 'tick', levels: levels('error') }).map((l) => l.n)).toEqual([2]);
    expect(filterLogLines(parsed, { query: 'nothing here', levels: none })).toEqual([]);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterLogLines(parsed, { query: '  gateway  ', levels: none }).map((l) => l.n)).toEqual([5]);
  });
});

describe('refreshScrollAction', () => {
  // A refresh for the same view keeps the reader's place, following the tail only when already parked at it.
  it('keeps the scroll on a same-view refresh away from the bottom', () => {
    expect(refreshScrollAction(true, false)).toBe('keep');
  });

  it('follows the tail on a same-view refresh when the reader is at the bottom', () => {
    expect(refreshScrollAction(true, true)).toBe('follow');
  });

  // Regression: a filter/severity change is a different, usually shorter document. Reapplying the previous
  // pixel scroll (or following its stale "bottom") threw a reader parked at the tail to the wrong place —
  // the expected behaviour is to show the top of the new results, regardless of the old bottom flag.
  it('shows the top on a view change, never reusing the previous scroll', () => {
    expect(refreshScrollAction(false, false)).toBe('top');
    expect(refreshScrollAction(false, true)).toBe('top');
  });
});

