import { describe, it, expect, vi } from 'vitest';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { setChatTheme } from '../../../src/cli/chat/theme.js';
import { WorkflowPanel, workflowTitle } from '../../../src/cli/chat/components.js';
import { openWorkflowModal } from '../../../src/cli/chat/workflowModal.js';
import { layoutWaves } from '../../../src/cli/chat/workflowCanvas.js';
import { TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import type { WorkflowState } from '../../../src/brain/transcript.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
const show = (label: string, lines: string[]): void => {
  // Print the rendered frame so the CLI layout can be eyeballed in test output (a deterministic stand-in
  // for the TMUX visual check — the daemon model was out of credit at authoring time).
  console.log(`\n──── ${label} ────`);
  for (const line of lines) console.log(strip(line));
};

const SPIN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

const WF: WorkflowState = {
  id: 'wf-1', toolCallId: 'call-1', title: 'ship the parser', status: 'running',
  nodes: [
    { id: 'gather', task: 'Read the parser sources and summarize the token grammar', status: 'done', deps: [], sessionId: 's-gather', tokens: 4200, seconds: 9, model: 'claude-opus-4-8', result: 'grammar has 14 token kinds' },
    { id: 'analyze', task: 'Find every edge case the grammar misses', status: 'running', deps: ['gather'], sessionId: 's-analyze', tokens: 1800, seconds: 5, detail: 'Read src/lexer.ts', model: 'claude-opus-4-8' },
    { id: 'write', task: 'Write the fix and a regression test', status: 'pending', deps: ['analyze'] },
  ],
};

interface ModalHandle { render(w: number): string[]; handleInput(d: string): void }
function openModal(getWorkflow: () => WorkflowState | undefined, terminal = { columns: 100, rows: 40 }): { modal: ModalHandle; onDrill: ReturnType<typeof vi.fn> } {
  let captured: ModalHandle | null = null;
  const onDrill = vi.fn();
  openWorkflowModal({
    tui: {
      showOverlay: (component: ModalHandle) => { captured = component; return { hide: vi.fn(), focus: vi.fn() }; },
      setFocus: vi.fn(), requestRender: vi.fn(), terminal,
    } as never,
    editor: {} as never, getWorkflow, onDrill,
  });
  expect(captured).not.toBeNull();
  return { modal: captured!, onDrill };
}

describe('workflowTitle', () => {
  it('appends one ellipsis to the model-authored label, stripping trailing punctuation first', () => {
    expect(workflowTitle(WF)).toBe('ship the parser…');
    expect(workflowTitle({ ...WF, title: 'ship the parser…' })).toBe('ship the parser…');
    expect(workflowTitle({ ...WF, title: 'ship the parser. ' })).toBe('ship the parser…');
  });

  it('falls back to the node count when there is no title', () => {
    expect(workflowTitle({ ...WF, title: undefined })).toBe('3-node workflow');
  });
});

describe('workflow CLI rendering', () => {
  // The durable way back into a workflow: the rail only carries RUNNING ones, so once a DAG finishes this
  // transcript row is the only thing that can still open its modal.
  it('renders the transcript marker on its WorkflowStart row, keyed for drill-in', () => {
    const renderer = new TurnRenderer(getMarkdownTheme());
    const model = new TranscriptModel([{
      role: 'assistant', text: '',
      segments: [{ kind: 'tool', id: 'call-1', name: 'WorkflowStart', detail: 'ship the parser', wf: WF }],
    }]);
    const turn = model.turnAt(0)!;
    const rows = renderer.render(turn, 0, 90, {
      showThoughts: false, thinkingSeconds: 0, composingMarkerReady: false, spinnerFrame: 0, expandedThoughts: new Set(), expandedTools: new Set(),
    });
    show('transcript marker', rows.map((r) => r.line));

    const flat = rows.map((r) => strip(r.line)).join('\n');
    expect(flat).toContain('Workflow');
    expect(flat).toContain('ship the parser');
    expect(flat).toContain('1✓ 1● 1⏸');          // the rail's tally, shared not re-derived
    expect(flat).toContain('6k tok');            // 4200 + 1800
    // Every marker row drills into the workflow by id, and the bare `WorkflowStart` tool row is gone —
    // the marker replaces it rather than stacking under a duplicate.
    const marked = rows.filter((r) => r.kind === 'workflow');
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((r) => r.key === 'wf-1')).toBe(true);
    expect(flat).not.toContain('⚙ workflow start');
  });

  it('renders the telemetry-rail Workflow section with a live tally', () => {
    const panel = new WorkflowPanel();
    panel.set([WF]);
    panel.setMaxRows(4);
    const lines = panel.render(46);
    show('rail Workflow section', lines);
    expect(strip(lines[0]!)).toContain('Workflow');
    expect(strip(lines[1]!)).toContain('ship the parser');
    // one workflow row, clickable
    expect(lines.some((l) => strip(l).includes('⛓'))).toBe(true);
  });
});

describe('workflow canvas layout', () => {
  it('layers nodes into topological waves without losing malformed ones', () => {
    // A diamond plus a second root: waves are longest-path layers, so both branches share a column.
    const waves = layoutWaves([
      { id: 'gather', task: 't', status: 'done', deps: [] },
      { id: 'audit', task: 't', status: 'pending', deps: [] },
      { id: 'lex', task: 't', status: 'done', deps: ['gather'] },
      { id: 'parse', task: 't', status: 'running', deps: ['gather'] },
      { id: 'report', task: 't', status: 'pending', deps: ['lex', 'parse'] },
    ]);
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([['gather', 'audit'], ['lex', 'parse'], ['report']]);

    // A cycle breaks at re-entry and a dangling dep reads as a root — every node keeps a place.
    const malformed = layoutWaves([
      { id: 'a', task: 'a', status: 'pending', deps: ['b'] },
      { id: 'b', task: 'b', status: 'pending', deps: ['a'] },
      { id: 'orphan', task: 'o', status: 'pending', deps: ['ghost'] },
    ]);
    expect(malformed.flat().map((n) => n.id).sort()).toEqual(['a', 'b', 'orphan']);
  });
});

describe('workflow canvas modal', () => {
  it('renders the DAG as wave columns with cards, edges and a live dock', () => {
    const { modal } = openModal(() => WF);
    const frame = modal.render(96);
    show('modal — circuit canvas', frame);
    const flat = frame.map(strip).join('\n');
    expect(flat).toContain('WORKFLOW');
    for (const id of ['gather', 'analyze', 'write']) expect(flat).toContain(id);
    expect(flat).toMatch(/╭ [✓✗⏸⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .+─+╮/); // the selected/running nodes draw as titled cards
    expect(flat).toContain('▶');    // dependency edges end in an arrowhead
    expect(flat).toMatch(SPIN);     // a running node spins
    // The first node starts selected: its dock names it, calls it a root, and offers the drill-in.
    expect(flat).toMatch(/─ gather ─/);
    expect(flat).toMatch(/deps\s+root/);
    expect(flat).toContain('enter open node transcript');
  });

  it('navigates waves with ←→ and the column with ↑↓, clamped at the edges', () => {
    const diamond: WorkflowState = {
      id: 'wf-d', toolCallId: 'call-d', title: 'diamond', status: 'running',
      nodes: [
        { id: 'gather', task: 'gather', status: 'done', deps: [], sessionId: 's-gather' },
        { id: 'audit', task: 'audit', status: 'pending', deps: [] },
        { id: 'lex', task: 'lex', status: 'done', deps: ['gather'], sessionId: 's-lex' },
        { id: 'parse', task: 'parse', status: 'running', deps: ['gather'], sessionId: 's-parse' },
        { id: 'report', task: 'report', status: 'pending', deps: ['lex', 'parse'] },
      ],
    };
    const { modal } = openModal(() => diamond, { columns: 130, rows: 40 });
    const dockOf = (): string => strip(modal.render(110).join('\n'));
    show('modal — diamond canvas', modal.render(110));

    modal.handleInput(DOWN);                       // column 1: gather → audit
    expect(dockOf()).toMatch(/─ audit ─/);
    modal.handleInput(DOWN);                       // bottom of the column: clamps, no wrap
    expect(dockOf()).toMatch(/─ audit ─/);
    modal.handleInput(UP);
    expect(dockOf()).toMatch(/─ gather ─/);
    modal.handleInput(LEFT);                       // left edge: clamps
    expect(dockOf()).toMatch(/─ gather ─/);
    modal.handleInput(RIGHT);                      // wave 2, nearest row to gather
    expect(dockOf()).toMatch(/─ lex ─/);
    modal.handleInput(DOWN);
    expect(dockOf()).toMatch(/─ parse ─/);
    modal.handleInput(RIGHT);                      // wave 3
    expect(dockOf()).toMatch(/─ report ─/);
    // The tree could only ever draw one parent — the dock carries the whole truth.
    expect(dockOf()).toMatch(/deps\s+lex, parse/);
    modal.handleInput(RIGHT);                      // right edge: clamps
    expect(dockOf()).toMatch(/─ report ─/);
  });

  it('drills into a started node and explains an unstarted one', () => {
    const { modal, onDrill } = openModal(() => WF);
    modal.handleInput(RIGHT);
    modal.handleInput(RIGHT);                      // 'write', pending, no session
    const flat = strip(modal.render(96).join('\n'));
    expect(flat).toContain('node not started');
    modal.handleInput('\r');
    expect(onDrill).not.toHaveBeenCalled();
    expect(strip(modal.render(96).join('\n'))).toContain('has not started yet');
    modal.handleInput(LEFT);                       // back to 'analyze' (has a session)
    modal.handleInput('\r');
    expect(onDrill).toHaveBeenCalledWith('s-analyze');
  });

  it('keeps the selection pinned to its node when the snapshot grows mid-run', () => {
    let wf: WorkflowState = WF;
    const { modal } = openModal(() => wf);
    modal.handleInput(RIGHT);                      // select 'analyze'
    expect(strip(modal.render(96).join('\n'))).toMatch(/─ analyze ─/);
    // WorkflowAddNodes prepends nothing in practice, but the selection must survive any reshuffle.
    wf = { ...WF, nodes: [{ id: 'extra', task: 'later', status: 'pending', deps: [] }, ...WF.nodes] };
    expect(strip(modal.render(96).join('\n'))).toMatch(/─ analyze ─/);
  });

  it('previews result, error and live elapsed time in the dock', () => {
    const outcome: WorkflowState = {
      id: 'wf-o', toolCallId: 'call-o', status: 'running',
      nodes: [
        { id: 'fetched', task: 'fetch pages', status: 'done', deps: [], sessionId: 's-f', tokens: 1200, seconds: 38, result: '31 pages fetched\nsecond line stays out of the dock' },
        { id: 'broken', task: 'explode', status: 'error', deps: [], sessionId: 's-b', error: 'boom exploded' },
        { id: 'live', task: 'analyze pages', status: 'running', deps: [], sessionId: 's-l', detail: 'Read src/a.ts', startedAt: Date.now() - 65_000 },
      ],
    };
    const { modal } = openModal(() => outcome);
    const flat = (): string => strip(modal.render(96).join('\n'));
    expect(flat()).toContain('▸ 31 pages fetched');
    expect(flat()).not.toContain('second line');
    modal.handleInput(DOWN);
    expect(flat()).toContain('✗ boom exploded');
    modal.handleInput(DOWN);
    show('modal — running node dock', modal.render(96));
    expect(flat()).toContain('▸ Read src/a.ts');
    expect(flat()).toMatch(/1m \d+s/); // ticks live from startedAt, not the stale snapshot seconds
  });

  it('toggles the dock between the selected node and the activity feed on tab', () => {
    const { modal } = openModal(() => WF);
    modal.handleInput('\t');
    const activity = strip(modal.render(96).join('\n'));
    show('modal — activity dock', modal.render(96));
    expect(activity).toMatch(/─ activity ─/);
    expect(activity).toContain('Read src/lexer.ts');            // the running node's live tool
    expect(activity).toContain('grammar has 14 token kinds');   // the finished node's result
    modal.handleInput('\t');
    expect(strip(modal.render(96).join('\n'))).toMatch(/─ gather ─/);
  });

  it('lists every node even when the DAG is malformed', () => {
    // A cycle should never reach the modal (the engine rejects it), but a node vanishing from the canvas
    // would be a silent lie about what is running — so unreachable nodes are emitted as their own roots.
    const cyclic: WorkflowState = {
      id: 'wf-c', toolCallId: 'call-c', status: 'running',
      nodes: [
        { id: 'a', task: 'a', status: 'pending', deps: ['b'] },
        { id: 'b', task: 'b', status: 'pending', deps: ['a'] },
        { id: 'orphan', task: 'orphan', status: 'pending', deps: ['ghost'] },
      ],
    };
    const { modal } = openModal(() => cyclic);
    const flat = strip(modal.render(90).join('\n'));
    for (const id of ['a', 'b', 'orphan']) expect(flat).toContain(id);
  });

  it('strips control sequences out of a model-authored dep id', () => {
    // The engine length-caps node ids but never validates their charset, and terminalSafeAnsi passes SGR
    // through by design — so an unsanitized dep id would repaint the modal's fixed palette from the inside.
    const hostile: WorkflowState = {
      id: 'wf-h', toolCallId: 'call-h', status: 'running',
      nodes: [
        { id: 'a', task: 'a', status: 'done', deps: [] },
        { id: 'b', task: 'b', status: 'running', deps: ['a', '\x1b[31mghost'] },
      ],
    };
    const { modal } = openModal(() => hostile);
    modal.handleInput(RIGHT); // select `b`, whose deps render in the dock
    const frame = modal.render(90);
    expect(frame.join('\n')).not.toContain('\x1b[31m');
    expect(strip(frame.join('\n'))).toMatch(/deps\s+a, ghost/);
  });

  it('falls back to a wave-grouped list on a narrow terminal, same keys included', () => {
    const { modal } = openModal(() => WF, { columns: 66, rows: 34 });
    const frame = modal.render(62);
    show('modal — narrow wave list', frame);
    const flat = frame.map(strip).join('\n');
    expect(flat).toContain('wave 1');
    expect(flat).toContain('wave 2');
    expect(flat).not.toContain('╭'); // no canvas cards
    expect(flat).not.toContain('│'); // no card borders either
    modal.handleInput(RIGHT);        // ←→ still navigates: jumps to the next wave
    expect(strip(modal.render(62).join('\n'))).toMatch(/─ analyze ─/);
  });

  it('keeps the footer inside the row budget on a short terminal', () => {
    const wordy: WorkflowState = {
      id: 'wf-w', toolCallId: 'call-w', title: 'wordy', status: 'running',
      nodes: [{
        id: 'gather', task: 'summarize the token grammar '.repeat(21).slice(0, 600),
        status: 'running', deps: [], sessionId: 's-gather', tokens: 4200, seconds: 9, detail: 'Read src/lexer.ts',
      }],
    };
    const { modal } = openModal(() => wordy, { columns: 120, rows: 20 });
    const frame = modal.render(108);
    show('modal — long task on a short terminal', frame);
    expect(frame.length).toBeLessThanOrEqual(16);  // modalGeometry's maxHeight at rows: 20
    const flat = frame.map(strip).join('\n');
    expect(flat).toContain('enter open node transcript'); // the footer survives
  });

  it('follows the active chat theme instead of owning a fixed palette', () => {
    setChatTheme('matrix');
    const onMatrix = openModal(() => WF).modal.render(90);
    setChatTheme('elowen');
    const onElowen = openModal(() => WF).modal.render(90);
    setChatTheme('elowen');
    // The modal is an Elowen surface, so /theme recolours it — the two frames must differ.
    expect(onMatrix).not.toEqual(onElowen);
    // Rows are painted on the theme's modalBg (elowen's is a warm near-black, matrix's a green one).
    expect(onElowen.join('')).toContain('\x1b[48;2;12;8;8m');
    expect(onMatrix.join('')).toContain('\x1b[48;2;1;9;5m');
  });

  it('renders every row at exactly the frame width, in both layouts', () => {
    const { modal } = openModal(() => WF, { columns: 120, rows: 40 });
    // The one invariant that guards the whole canvas-window recipe: a cell padded with String.padEnd or
    // an un-truncated wrap would drift the row and tear the background.
    for (const width of [110, 90, 64, 56]) {
      for (const row of modal.render(width)) {
        expect(visibleWidth(row)).toBe(width);
      }
    }
  });

  it('scrolls the canvas to keep the selection visible', () => {
    const big: WorkflowState = {
      id: 'wf-big', toolCallId: 'call-9', status: 'running',
      nodes: Array.from({ length: 30 }, (_, i) => ({
        id: `node-${i}`, task: `task ${i}`, status: 'pending' as const, deps: [],
      })),
    };
    const { modal } = openModal(() => big, { columns: 100, rows: 24 });
    for (let i = 0; i < 25; i += 1) modal.handleInput(DOWN);
    const flat = modal.render(90).map(strip).join('\n');
    expect(flat).toContain('node-25');
    expect(flat).not.toContain('node-0\n');
    expect(flat).toContain('↕'); // the scroll affordance appears once the canvas clips

    // ↑ clamps at the top — the selection is a position in space, not a wrapping list index.
    for (let i = 0; i < 30; i += 1) modal.handleInput(UP);
    expect(modal.render(90).map(strip).join('\n')).toMatch(/─ node-0 ─/);
  });

  it('shows a full frame, not a broken one, when there is nothing to show', () => {
    expect(openModal(() => undefined).modal.render(90).map(strip).join('\n')).toContain('no longer in the live view');
    expect(openModal(() => ({ ...WF, nodes: [] })).modal.render(90).map(strip).join('\n')).toContain('still being built');
  });
});
