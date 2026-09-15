import { describe, it, expect, vi } from 'vitest';
import { shapeBrainMessages, withWorkflowAnchors } from '../../../src/brain/messageView.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { openWorkflowModal } from '../../../src/cli/chat/workflowModal.js';
import type { BrainWorkflowView } from '../../../src/shared/wireContract.js';

/** The CLI across a daemon restart, driven exactly as the chat does it: one TranscriptModel, one modal
 *  instance reading `transcript.workflows()` every frame, and the REAL daemon-side snapshot shaping
 *  (shapeBrainMessages + withWorkflowAnchors) standing in for the frames a reconnect delivers.
 *
 *  Nothing here is remounted: the modal opened before the restart is the same object asserted after it,
 *  because the bug this pins is precisely that a CLI which stayed open kept rendering pre-restart node
 *  statuses until the whole process was relaunched. */

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The parent conversation's durable rows: a turn whose WorkflowStart call anchors the DAG. */
const ROWS = [
  { id: 'row-user', role: 'user', content: JSON.stringify({ role: 'user', content: 'run the pipeline' }), created_at: '2026-09-15 10:00:00' },
  {
    id: 'row-assistant', role: 'assistant', created_at: '2026-09-15 10:00:01',
    content: JSON.stringify({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'WorkflowStart', arguments: { nodesFile: '/tmp/nodes.json' } }],
    }),
  },
];

const run = (nodes: BrainWorkflowView['nodes'], status: BrainWorkflowView['status'] = 'running'): BrainWorkflowView => ({
  id: 'wf-1', toolCallId: 'call-1', title: 'ship the pipeline', status, nodes,
});

const BEFORE = run([
  { id: 'build', task: 'build the thing', status: 'running', deps: [], sessionId: 's-build', detail: 'Bash npm run build', startedAt: 1_000 },
  { id: 'verify', task: 'verify the thing', status: 'pending', deps: ['build'] },
]);
/** What the durable store holds once boot recovery has moved the DAG on. */
const AFTER = run([
  { id: 'build', task: 'build the thing', status: 'done', deps: [], sessionId: 's-build', result: 'build ok' },
  { id: 'verify', task: 'verify the thing', status: 'running', deps: ['build'], sessionId: 's-verify', detail: 'Bash npm test', startedAt: 2_000 },
]);

/** The history a `/brain/stream?snapshot=1` frame carries for this conversation. `anchored` models the
 *  case where the WorkflowStart row was compacted or windowed out and the daemon pins a synthetic anchor. */
function snapshotHistory(workflow: BrainWorkflowView, anchored: 'row' | 'synthetic'): ReturnType<typeof shapeBrainMessages> {
  const views = anchored === 'row' ? shapeBrainMessages(ROWS, [], [], [workflow]) : shapeBrainMessages([ROWS[0]!]);
  return withWorkflowAnchors(views, [workflow]);
}

interface ModalHandle { render(w: number): string[]; handleInput(d: string): void }
function openModal(transcript: TranscriptModel): ModalHandle {
  let captured: ModalHandle | null = null;
  openWorkflowModal({
    tui: {
      showOverlay: (component: ModalHandle) => { captured = component; return { hide: vi.fn(), focus: vi.fn() }; },
      setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 110, rows: 40 },
    } as never,
    editor: {} as never,
    getWorkflow: () => transcript.workflows().find((wf) => wf.id === 'wf-1'),
    onDrill: vi.fn(),
  });
  expect(captured).not.toBeNull();
  return captured!;
}

describe('workflow modal across a daemon restart', () => {
  it('reconciles the open modal from the reconnect snapshot: the finished node turns done and the focus moves to the one now running', () => {
    const transcript = new TranscriptModel(snapshotHistory(BEFORE, 'row'));
    const modal = openModal(transcript);
    const flat = (): string => strip(modal.render(100).join('\n'));
    expect(flat()).toMatch(/─ build ─/);
    expect(flat()).toContain('▸ Bash npm run build');

    // The daemon restarts. The CLI's stream reconnects and replaces the transcript with the fresh
    // snapshot — the durable workflow row is the authority, and the modal must follow it in place.
    transcript.replaceHistory(snapshotHistory(AFTER, 'row'));

    const reconnected = flat();
    expect(reconnected).toContain('✓ build');        // completed before/during the restart → done
    expect(reconnected).toMatch(/─ verify ─/);       // focus moved to what is actually running
    expect(reconnected).toContain('▸ Bash npm test');
    expect(reconnected).toMatch(/1\/2 · ✓1 ●1/);
  });

  it('keeps applying live workflow events onto the anchor the reconnect rebuilt', () => {
    const transcript = new TranscriptModel(snapshotHistory(BEFORE, 'row'));
    const modal = openModal(transcript);
    const flat = (): string => strip(modal.render(100).join('\n'));

    transcript.replaceHistory(snapshotHistory(AFTER, 'row'));
    expect(flat()).toMatch(/─ verify ─/);
    // Boot recovery's own publish, which now reaches an attached client with no live brain
    // (see tests/brain/workflowResumePublish.test.ts).
    expect(transcript.apply({
      type: 'workflow',
      ...run([
        { id: 'build', task: 'build the thing', status: 'done', deps: [], sessionId: 's-build', result: 'build ok' },
        { id: 'verify', task: 'verify the thing', status: 'done', deps: ['build'], sessionId: 's-verify', result: 'tests pass' },
      ], 'done'),
    })).toBe(true);

    const finished = flat();
    expect(finished).toContain('✓ done');             // the run's own status pill
    expect(finished).toContain('▸ tests pass');
    expect(finished).toMatch(/2\/2 · ✓2/);
  });

  it('projects one workflow, not one per snapshot, when a synthetic anchor and the real row both arrive', () => {
    // A reconnect inside the boot window can pin a synthetic anchor (the real row was compacted out of the
    // page); a later refetch serves the real row. Both carry the same workflow id and tool call id, so the
    // projection — and the modal, and the rail — must still show exactly one DAG.
    const transcript = new TranscriptModel(snapshotHistory(BEFORE, 'synthetic'));
    expect(transcript.workflows()).toHaveLength(1);
    transcript.apply({ type: 'workflow', ...AFTER });
    expect(transcript.workflows()).toHaveLength(1);

    transcript.replaceHistory(snapshotHistory(AFTER, 'row'));
    expect(transcript.workflows()).toHaveLength(1);
    expect(transcript.workflows()[0]!.nodes.map((n) => `${n.id}:${n.status}`)).toEqual(['build:done', 'verify:running']);
    // And the transcript itself carries a single WorkflowStart anchor row for it.
    const anchors = [];
    for (let index = 0; index < transcript.turnCount; index += 1) {
      const turn = transcript.turnAt(index);
      if (turn?.role !== 'elowen') continue;
      for (const segment of turn.segments) {
        if (segment.kind !== 'tools') continue;
        for (const item of segment.items) if (item.wf) anchors.push(item.id);
      }
    }
    expect(anchors).toEqual(['call-1']);
  });
});
