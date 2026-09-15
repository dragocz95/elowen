import { describe, it, expect } from 'vitest';
import { traceForCall, ToolTraceLog } from '../../src/brain/toolTrace/record.js';
import { segmentsForTraces, traceNotes } from '../../src/brain/toolTrace/segments.js';
import { openEventsForCall, settleEventsForTrace } from '../../src/brain/toolTrace/liveEvents.js';
import { MAX_TRACE_BYTES, MAX_TRACE_RECORDS, parseToolTraces, traceRowId, type ToolTrace } from '../../src/brain/toolTrace/types.js';

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

describe('ToolTraceLog budget', () => {
  it('stops at the record cap and says how many calls it did not record', () => {
    const log = new ToolTraceLog();
    for (let i = 0; i < MAX_TRACE_RECORDS + 50; i++) log.push({ kind: 'call', name: `Tool${i}` });

    const records = log.records();
    expect(records.filter((r) => r.kind === 'call')).toHaveLength(MAX_TRACE_RECORDS);
    expect(records[records.length - 1]).toEqual({ kind: 'note', text: '… 50 further call(s) not recorded' });
  });

  it('keeps a huge call as its bare identity rather than dropping it silently', () => {
    const log = new ToolTraceLog();
    const huge = { kind: 'call', name: 'Write', diff: 'x'.repeat(MAX_TRACE_BYTES) } satisfies ToolTrace;

    const accepted = log.push(huge);

    expect(accepted).toEqual({ kind: 'call', name: 'Write' });
    // What was accepted is what a caller may emit live: the reduced record, never the original.
    expect(log.records()).toEqual([{ kind: 'call', name: 'Write' }]);
  });

  it('reports whether any call was recorded, which decides the wrapper row', () => {
    const empty = new ToolTraceLog();
    expect(empty.hasCalls()).toBe(false);
    empty.push({ kind: 'note', text: 'working…' });
    expect(empty.hasCalls()).toBe(false);
    empty.push({ kind: 'call', name: 'Read' });
    expect(empty.hasCalls()).toBe(true);
  });
});

describe('segmentsForTraces', () => {
  it('derives row ids from the owning call id and the record index', () => {
    const traces: ToolTrace[] = [{ kind: 'call', name: 'Bash' }, { kind: 'call', name: 'Write' }];

    const segments = segmentsForTraces(traces, 'call_1');

    expect(segments.map((s) => (s.kind === 'tool' ? s.id : undefined))).toEqual(['call_1:0', 'call_1:1']);
    expect(traceRowId('call_1', 1)).toBe('call_1:1');
  });

  it('counts notes in the index, so live ids and hydrated ids cannot drift', () => {
    const traces: ToolTrace[] = [{ kind: 'note', text: 'step 1' }, { kind: 'call', name: 'Bash' }];

    const segments = segmentsForTraces(traces, 'call_1');

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind === 'tool' && segments[0].id).toBe('call_1:1');
  });

  it('rides a note on the first row instead of inventing a row for it', () => {
    const traces: ToolTrace[] = [{ kind: 'call', name: 'Bash' }, { kind: 'note', text: 'halfway' }];

    const segments = segmentsForTraces(traces, 'call_1');

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind === 'tool' && segments[0].output?.notes).toEqual(['halfway']);
  });

  it('produces no rows when nothing was called, leaving the wrapper its own row', () => {
    expect(segmentsForTraces([{ kind: 'note', text: 'computed 2+2' }], 'call_1')).toEqual([]);
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
