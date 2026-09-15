import { describe, it, expect } from 'vitest';
import { traceForCall, ToolTraceLog } from '../../src/brain/toolTrace/record.js';
import { segmentsForTraces, traceNotes } from '../../src/brain/toolTrace/segments.js';
import { openEventsForCall, settleEventsForTrace } from '../../src/brain/toolTrace/liveEvents.js';
import { MAX_TRACE_BYTES, MAX_TRACE_RECORDS, parseToolTraces, traceRowId } from '../../src/brain/toolTrace/types.js';

/** A console tool result in the exact framing the terminal plugin produces. */
const bashResult = (out: string, exitCode = 0) => ({
  content: [{ type: 'text', text: `$ ls -la\n(cwd: /tmp)\n${out}\n[exit ${exitCode}]` }],
  details: { exitCode },
});

describe('traceForCall', () => {
  it('records a console call with its verbatim command and stripped output', () => {
    const trace = traceForCall('Bash', { command: 'ls -la' }, bashResult('total 0'));

    expect(trace.kind).toBe('call');
    expect(trace.name).toBe('Bash');
    expect(trace.command).toBe('ls -la');
    expect(trace.output?.kind).toBe('console');
    // The `$ cmd` / `(cwd:)` / `[exit N]` framing exists for the model; the reader gets the real output.
    expect(trace.output?.text).toBe('total 0');
    expect(trace.output?.cwd).toBe('/tmp');
    expect(trace.diff).toBeUndefined();
  });

  it('records an edit as a diff, with no output block beside it', () => {
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new';
    const trace = traceForCall('Write', { file_path: '/tmp/a.ts' }, { details: { diff } });

    expect(trace.diff).toBe(diff);
    expect(trace.output).toBeUndefined();
  });

  it('marks a refusal as an error so the row is flagged', () => {
    const trace = traceForCall('Bash', { command: 'rm -rf /' }, { content: [{ type: 'text', text: 'refused by policy' }] }, true);

    expect(trace.isError).toBe(true);
  });
});

describe('ToolTraceLog', () => {
  it('mints ids from the producer and the record position', () => {
    const log = new ToolTraceLog('cell_1');

    expect(log.open('Bash')).toBe('cell_1:0');
    expect(log.note('halfway')).toBe('cell_1:1');
    expect(log.open('Write')).toBe('cell_1:2');
    expect(traceRowId('cell_1', 2)).toBe('cell_1:2');
  });

  it('hands each record out exactly once, so two reporting calls cannot draw one row twice', () => {
    const log = new ToolTraceLog('cell_1');
    log.settle(log.open('Bash')!, traceForCall('Bash', { command: 'ls' }, bashResult('a')));

    const first = log.drain();
    expect(first.map((r) => (r.kind === 'call' ? r.row : r.kind))).toEqual(['cell_1:0']);

    // Nothing new yet: a `wait` on the same cell must report nothing rather than repeat the row.
    expect(log.drain()).toEqual([]);

    log.open('Write');
    expect(log.drain().map((r) => (r.kind === 'call' ? r.row : r.kind))).toEqual(['cell_1:1']);
  });

  it('stops handing out rows at the cap and says how many calls it did not record', () => {
    const log = new ToolTraceLog('cell_1');
    const rows = Array.from({ length: MAX_TRACE_RECORDS + 50 }, (_, i) => log.open(`Tool${i}`));

    expect(rows.filter((r) => r !== undefined)).toHaveLength(MAX_TRACE_RECORDS);
    const records = log.drain();
    expect(records.filter((r) => r.kind === 'call')).toHaveLength(MAX_TRACE_RECORDS);
    expect(records[records.length - 1]).toEqual({ kind: 'note', text: '… 50 further call(s) not recorded' });
    // The count is reported once, not re-reported on every later drain.
    expect(log.drain()).toEqual([]);
  });

  it('keeps a row that was handed out, shrinking the record instead of losing it', () => {
    const log = new ToolTraceLog('cell_1');
    const row = log.open('Write')!;

    const stored = log.settle(row, { kind: 'call', name: 'Write', diff: 'x'.repeat(MAX_TRACE_BYTES) });

    // The live row for cell_1:0 was already drawn, so a durable twin MUST remain under that id.
    expect(stored).toEqual({ kind: 'call', row: 'cell_1:0', name: 'Write' });
    expect(log.drain()).toEqual([{ kind: 'call', row: 'cell_1:0', name: 'Write' }]);
  });

  it('upgrades a settled call to its full record when it fits', () => {
    const log = new ToolTraceLog('cell_1');
    const row = log.open('Bash')!;
    const full = traceForCall('Bash', { command: 'ls' }, bashResult('a'));

    expect(log.settle(row, full)).toEqual({ ...full, row });
  });

  it('reports whether any call was recorded, which decides the wrapper row', () => {
    const log = new ToolTraceLog('cell_1');
    expect(log.hasCalls()).toBe(false);
    log.note('working…');
    expect(log.hasCalls()).toBe(false);
    log.open('Read');
    expect(log.hasCalls()).toBe(true);
  });
});

describe('segmentsForTraces', () => {
  it('reads the row id off the record rather than recomputing it', () => {
    const segments = segmentsForTraces([
      { kind: 'call', row: 'cell_1:0', name: 'Bash' },
      { kind: 'call', row: 'cell_1:4', name: 'Write' },
    ]);

    expect(segments.map((s) => (s.kind === 'tool' ? s.id : undefined))).toEqual(['cell_1:0', 'cell_1:4']);
  });

  it('rides a note on the first row instead of inventing a row for it', () => {
    const segments = segmentsForTraces([{ kind: 'call', row: 'cell_1:0', name: 'Bash' }, { kind: 'note', text: 'halfway' }]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind === 'tool' && segments[0].output?.notes).toEqual(['halfway']);
  });

  it('produces no rows when nothing was called, leaving the wrapper its own row', () => {
    expect(segmentsForTraces([{ kind: 'note', text: 'computed 2+2' }])).toEqual([]);
    expect(traceNotes([{ kind: 'note', text: 'computed 2+2' }])).toEqual(['computed 2+2']);
  });
});

describe('live events', () => {
  it('opens a row when the call starts and settles it from the accepted record', () => {
    // `detail` is the salient argument the shared formatter derives — the same label a direct call shows.
    expect(openEventsForCall('Bash', { command: 'npm test' }, 'call_1:0')).toEqual([
      { type: 'tool', name: 'Bash', detail: 'npm test', command: 'npm test', id: 'call_1:0' },
    ]);

    const diff = '--- a\n+++ b';
    expect(settleEventsForTrace({ kind: 'call', name: 'Write', diff }, 'call_1:0')).toEqual([
      { type: 'diff', diff, id: 'call_1:0' },
    ]);
    expect(settleEventsForTrace({ kind: 'call', name: 'Read', isError: true }, 'call_1:1')).toEqual([
      { type: 'tool_end', id: 'call_1:1', isError: true },
    ]);
    expect(settleEventsForTrace({ kind: 'note', text: 'halfway' }, 'call_1:2')).toEqual([
      { type: 'tool_progress', id: 'call_1:2', text: 'halfway' },
    ]);
  });
});

describe('parseToolTraces', () => {
  it('drops anything that is not a well-formed record', () => {
    expect(parseToolTraces('nope')).toEqual([]);
    expect(parseToolTraces([null, 7, { kind: 'call' }, { kind: 'note' }, { kind: 'other', name: 'x' }])).toEqual([]);
    expect(parseToolTraces([{ kind: 'call', name: 'Bash', extra: 1 }])).toEqual([{ kind: 'call', name: 'Bash' }]);
  });
});
