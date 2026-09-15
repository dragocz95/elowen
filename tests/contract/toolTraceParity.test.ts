import { describe, it, expect } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toBrainEvent } from '../../src/brain/events.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import { traceForCall } from '../../src/brain/toolTrace/record.js';
import { segmentsForTraces } from '../../src/brain/toolTrace/segments.js';
import { openEventsForCall, settleEventsForTrace } from '../../src/brain/toolTrace/liveEvents.js';

/**
 * THE test that keeps `src/brain/toolTrace/` honest.
 *
 * A row for tool activity the provider never saw has to be indistinguishable from a row for a call the
 * model made itself — on the live stream AND after a reload. Two ways for that to break, and a user sees
 * both: a nested row that renders with fewer fields than a direct one, or a live row whose id differs
 * from the hydrated one, which draws the row twice instead of patching it.
 *
 * So this compares the two paths over the SAME (name, args, result), field by field, rather than
 * asserting the trace path against a hand-written expectation of itself.
 */

const cases: { name: string; args: unknown; result: unknown; isError?: boolean }[] = [
  {
    name: 'Bash',
    args: { command: 'npm test -- --run' },
    result: { content: [{ type: 'text', text: '$ npm test -- --run\n(cwd: /var/www/app)\n12 passed\n[exit 0]' }], details: { exitCode: 0 } },
  },
  {
    name: 'Bash',
    args: { command: 'npm run build' },
    result: { content: [{ type: 'text', text: '$ npm run build\n(cwd: /var/www/app)\nTS2304: Cannot find name\n[exit 2]' }], details: { exitCode: 2 } },
    isError: true,
  },
  {
    name: 'Write',
    args: { file_path: '/var/www/app/a.ts' },
    result: { details: { diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new' } },
  },
  {
    name: 'Grep',
    args: { pattern: 'needle', path: '/var/www/app' },
    result: { content: [{ type: 'text', text: 'a.ts:1:needle' }] },
  },
];

/** The direct path's live events for one call: the start event, then the settle event. */
function directLiveEvents(c: (typeof cases)[number]) {
  const start = toBrainEvent({ type: 'tool_execution_start', toolName: c.name, toolCallId: 'call_x', args: c.args } as unknown as AgentSessionEvent);
  const end = toBrainEvent({ type: 'tool_execution_end', toolName: c.name, toolCallId: 'call_x', result: c.result, isError: c.isError === true } as unknown as AgentSessionEvent);
  return { start, end };
}

/** The direct path's hydrated segment for one call, from a synthetic assistant row + toolResult row. */
function directSegment(c: (typeof cases)[number]) {
  const views = shapeBrainMessages([
    { role: 'assistant', content: JSON.stringify({ content: [{ type: 'toolCall', id: 'call_x', name: c.name, arguments: c.args }] }) },
    { role: 'toolResult', content: JSON.stringify({ toolCallId: 'call_x', ...(c.result as object), isError: c.isError === true }) },
  ]);
  const segment = views[0]?.segments?.[0];
  return segment?.kind === 'tool' ? segment : undefined;
}

describe('a recorded row renders like a direct one', () => {
  for (const c of cases) {
    it(`${c.name}${c.isError ? ' (failing)' : ''}: the hydrated segment carries the same display fields`, () => {
      const direct = directSegment(c);
      expect(direct, 'the direct path must produce a tool segment for this fixture').toBeDefined();

      const trace = traceForCall(c.name, c.args, c.result, c.isError);
      const [recorded] = segmentsForTraces([{ ...trace, row: 'call_x:0' }]);
      expect(recorded?.kind).toBe('tool');
      if (recorded?.kind !== 'tool' || direct === undefined) return;

      expect(recorded.name).toBe(direct.name);
      expect(recorded.detail).toEqual(direct.detail);
      expect(recorded.command).toEqual(direct.command);
      expect(recorded.diff).toEqual(direct.diff);
      expect(recorded.output).toEqual(direct.output);
    });

    it(`${c.name}${c.isError ? ' (failing)' : ''}: the live events match the direct stream`, () => {
      const { start, end } = directLiveEvents(c);
      const trace = traceForCall(c.name, c.args, c.result, c.isError);

      const [open] = openEventsForCall(c.name, c.args, 'call_x:0');
      expect(open?.type).toBe('tool');
      if (open?.type === 'tool' && start?.type === 'tool') {
        expect(open.name).toBe(start.name);
        expect(open.detail).toEqual(start.detail);
        expect(open.command).toEqual(start.command);
      }

      const [settle] = settleEventsForTrace(trace, 'call_x:0');
      expect(settle?.type).toBe(end?.type);
      if (settle?.type === 'tool_output' && end?.type === 'tool_output') {
        // The direct END event carries no arguments (`events.ts:695`), so its output has no `command`;
        // the transcript model threads it in from the matching start row (`transcriptModel.ts:257`).
        // A recorded call has its arguments at settle time and fills the field directly, so parity is
        // asserted against the direct output AFTER that same threading — the state a client renders.
        const threaded = start?.type === 'tool' && start.command && !end.output.command
          ? { ...end.output, command: start.command }
          : end.output;
        expect(settle.output).toEqual(threaded);
      }
      if (settle?.type === 'diff' && end?.type === 'diff') {
        expect(settle.diff).toBe(end.diff);
        expect(settle.output).toEqual(end.output);
      }
    });

    it(`${c.name}${c.isError ? ' (failing)' : ''}: the live row id equals the hydrated row id`, () => {
      const trace = traceForCall(c.name, c.args, c.result, c.isError);
      const [recorded] = segmentsForTraces([{ ...trace, row: 'call_x:0' }]);
      const [open] = openEventsForCall(c.name, c.args, 'call_x:0');
      const [settle] = settleEventsForTrace(trace, 'call_x:0');

      const hydratedId = recorded?.kind === 'tool' ? recorded.id : undefined;
      expect(hydratedId).toBe('call_x:0');
      expect(open?.type === 'tool' ? open.id : undefined).toBe(hydratedId);
      expect(settle && 'id' in settle ? settle.id : undefined).toBe(hydratedId);
    });
  }
});

describe('hydration expands a wrapper call into its recorded rows', () => {
  const wrapper = (records: unknown) => shapeBrainMessages([
    { role: 'assistant', content: JSON.stringify({ content: [{ type: 'toolCall', id: 'exec_1', name: 'exec', arguments: { input: 'await tools.Bash(...)' } }] }) },
    { role: 'toolResult', content: JSON.stringify({ toolCallId: 'exec_1', content: [{ type: 'text', text: 'ok' }], details: { toolTrace: records } }) },
  ]);

  it('replaces the wrapper row with the rows it recorded', () => {
    const traces = [
      { ...traceForCall('Bash', { command: 'ls' }, { content: [{ type: 'text', text: '$ ls\n(cwd: /tmp)\na\n[exit 0]' }], details: { exitCode: 0 } }), row: 'cell_1:0' },
      { ...traceForCall('Write', { file_path: '/tmp/a' }, { details: { diff: '--- a\n+++ b' } }), row: 'cell_1:1' },
    ];

    const segments = wrapper(traces)[0]?.segments ?? [];

    expect(segments.map((s) => (s.kind === 'tool' ? s.name : s.kind))).toEqual(['Bash', 'Write']);
    expect(segments.map((s) => (s.kind === 'tool' ? s.id : undefined))).toEqual(['cell_1:0', 'cell_1:1']);
  });

  it('keeps the wrapper row when nothing was called, carrying its notes', () => {
    const segments = wrapper([{ kind: 'note', text: 'computed the total' }])[0]?.segments ?? [];

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind === 'tool' && segments[0].name).toBe('exec');
    expect(segments[0]?.kind === 'tool' && segments[0].output?.notes).toEqual(['computed the total']);
  });

  it('ignores a malformed payload instead of losing the turn', () => {
    const segments = wrapper('not an array')[0]?.segments ?? [];

    expect(segments[0]?.kind === 'tool' && segments[0].name).toBe('exec');
  });
});
