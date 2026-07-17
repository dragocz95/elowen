import { describe, it, expect, vi } from 'vitest';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { setChatTheme } from '../../../src/cli/chat/theme.js';
import { WorkflowPanel } from '../../../src/cli/chat/components.js';
import { openWorkflowModal } from '../../../src/cli/chat/workflowModal.js';
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

const WF: WorkflowState = {
  id: 'wf-1', toolCallId: 'call-1', title: 'ship the parser', status: 'running',
  nodes: [
    { id: 'gather', task: 'Read the parser sources and summarize the token grammar', status: 'done', deps: [], sessionId: 's-gather', tokens: 4200, seconds: 9, model: 'claude-opus-4-8' },
    { id: 'analyze', task: 'Find every edge case the grammar misses', status: 'running', deps: ['gather'], sessionId: 's-analyze', tokens: 1800, seconds: 5, detail: 'read_file src/lexer.ts', model: 'claude-opus-4-8' },
    { id: 'write', task: 'Write the fix and a regression test', status: 'pending', deps: ['analyze'] },
  ],
};

describe('workflow CLI rendering', () => {
  // The durable way back into a workflow: the rail only carries RUNNING ones, so once a DAG finishes this
  // transcript row is the only thing that can still open its modal.
  it('renders the transcript marker on its workflow_start row, keyed for drill-in', () => {
    const renderer = new TurnRenderer(getMarkdownTheme());
    const model = new TranscriptModel([{
      role: 'assistant', text: '',
      segments: [{ kind: 'tool', id: 'call-1', name: 'workflow_start', detail: 'ship the parser', wf: WF }],
    }]);
    const turn = model.turnAt(0)!;
    const rows = renderer.render(turn, 0, 90, {
      showThoughts: false, thinkingSeconds: 0, expandedThoughts: new Set(), expandedTools: new Set(),
    });
    show('transcript marker', rows.map((r) => r.line));

    const flat = rows.map((r) => strip(r.line)).join('\n');
    expect(flat).toContain('Workflow');
    expect(flat).toContain('ship the parser');
    expect(flat).toContain('1✓ 1● 1⏸');          // the rail's tally, shared not re-derived
    expect(flat).toContain('6k tok');            // 4200 + 1800
    // Every marker row drills into the workflow by id, and the bare `workflow_start` tool row is gone —
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

  it('renders the navigable modal and moves selection on arrow keys', () => {
    let captured: { render(w: number): string[]; handleInput(d: string): void } | null = null;
    const tui = {
      showOverlay: (component: typeof captured) => { captured = component; return { hide: vi.fn(), focus: vi.fn() }; },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      terminal: { columns: 100, rows: 40 },
    };
    const onDrill = vi.fn();
    openWorkflowModal({
      tui: tui as never,
      editor: {} as never,
      getWorkflow: () => WF,
      onDrill,
    });
    expect(captured).not.toBeNull();
    const modal = captured!;

    const frame0 = modal.render(90);
    show('modal — node "gather" selected', frame0);
    const flat0 = frame0.map(strip).join('\n');
    expect(flat0).toContain('Workflow');
    expect(flat0).toContain('gather');
    expect(flat0).toContain('root'); // gather has no deps — its detail column says so
    expect(flat0).toContain('enter open node transcript'); // selected node has a session

    // Deps are per-selected-node data and now live in the detail column, so they show while their node
    // is selected rather than on every list row.
    modal.handleInput('\x1b[B');
    const frame1 = modal.render(90);
    show('modal — node "analyze" selected', frame1);
    expect(frame1.map(strip).join('\n')).toContain('deps: gather');

    // Arrow down again → the pending 'write' node (no session) → the hint changes.
    modal.handleInput('\x1b[B');
    const frame2 = modal.render(90);
    show('modal — node "write" selected (pending)', frame2);
    expect(frame2.map(strip).join('\n')).toContain('node not started');

    // Enter on a node that has not started says so, instead of silently doing nothing.
    modal.handleInput('\r');
    expect(onDrill).not.toHaveBeenCalled();
    expect(modal.render(90).map(strip).join('\n')).toContain('has not started yet');

    // Enter on a started node drills into its session.
    modal.handleInput('\x1b[A'); // back up to 'analyze' (has a session)
    modal.handleInput('\r');
    expect(onDrill).toHaveBeenCalledWith('s-analyze');
  });

  it('lays the node list out as a dependency tree', () => {
    // A diamond: `report` waits on BOTH branches, which is exactly where a DAG stops being a tree.
    const diamond: WorkflowState = {
      id: 'wf-d', toolCallId: 'call-d', title: 'diamond', status: 'running',
      nodes: [
        { id: 'gather', task: 'gather', status: 'done', deps: [] },
        { id: 'lex', task: 'lex', status: 'done', deps: ['gather'] },
        { id: 'parse', task: 'parse', status: 'running', deps: ['gather'] },
        { id: 'report', task: 'report', status: 'pending', deps: ['lex', 'parse'] },
        { id: 'audit', task: 'audit', status: 'pending', deps: [] },
      ],
    };
    let captured: { render(w: number): string[]; handleInput(d: string): void } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 120, rows: 40 },
      } as never,
      editor: {} as never, getWorkflow: () => diamond, onDrill: vi.fn(),
    });
    const frame = captured!.render(110);
    show('modal — dependency tree (diamond)', frame);
    const list = frame.map((l) => strip(l).slice(0, 48));

    // Children hang under their first dependency; `report` sits under `lex` and both roots stay at the
    // left margin. The tree draws ONE parent per node — `report` also waits on `parse`, which is why the
    // detail column carries the full list rather than the layout pretending otherwise.
    expect(list.some((l) => /^\s+✓ gather/.test(l))).toBe(true);
    expect(list.some((l) => /├─ ✓ lex/.test(l))).toBe(true);
    expect(list.some((l) => /│\s+└─ ⏸ report/.test(l))).toBe(true);
    expect(list.some((l) => /└─ ● parse/.test(l))).toBe(true);
    expect(list.some((l) => /^\s+⏸ audit/.test(l))).toBe(true); // a second root, not nested

    // Arrows walk VISUAL order: two rows down from `gather` is `report` — the third row on screen, not
    // the third node declared. Its detail carries the whole truth the tree can only half-draw.
    captured!.handleInput('\x1b[B');
    captured!.handleInput('\x1b[B');
    expect(strip(captured!.render(110).join('\n'))).toContain('deps: lex, parse');
  });

  it('lists every node even when the DAG is malformed', () => {
    // A cycle should never reach the modal (the engine rejects it), but a node vanishing from the list
    // would be a silent lie about what is running — so unreachable nodes are emitted as their own roots.
    const cyclic: WorkflowState = {
      id: 'wf-c', toolCallId: 'call-c', status: 'running',
      nodes: [
        { id: 'a', task: 'a', status: 'pending', deps: ['b'] },
        { id: 'b', task: 'b', status: 'pending', deps: ['a'] },
        { id: 'orphan', task: 'orphan', status: 'pending', deps: ['ghost'] },
      ],
    };
    let captured: { render(w: number): string[] } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 100, rows: 40 },
      } as never,
      editor: {} as never, getWorkflow: () => cyclic, onDrill: vi.fn(),
    });
    const flat = strip(captured!.render(90).join('\n'));
    for (const id of ['a', 'b', 'orphan']) expect(flat).toMatch(new RegExp(`[✓●⏸✗] ${id}\\b`));
  });

  it('keeps the footer when a long task overflows the detail column', () => {
    // The overlay trims a too-tall modal from the BOTTOM, so any row the detail column overspends is paid
    // for by the footer — the one row telling the user which keys work. A short terminal is where this
    // bites: the task is store-bounded to 600 chars, which only outgrows the detail column once the row
    // budget is small.
    const wordy: WorkflowState = {
      id: 'wf-w', toolCallId: 'call-w', title: 'wordy', status: 'running',
      nodes: [{
        id: 'gather', task: 'summarize the token grammar '.repeat(21).slice(0, 600),
        status: 'running', deps: [], sessionId: 's-gather', tokens: 4200, seconds: 9, detail: 'Read src/lexer.ts',
      }],
    };
    let captured: { render(w: number): string[] } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 120, rows: 20 },
      } as never,
      editor: {} as never, getWorkflow: () => wordy, onDrill: vi.fn(),
    });
    const frame = captured!.render(108);
    show('modal — long task on a short terminal', frame);

    expect(frame.length).toBeLessThanOrEqual(16); // modalGeometry's maxHeight at rows: 20
    const flat = frame.map(strip).join('\n');
    expect(flat).toContain('enter open node transcript'); // the row an overrun used to eat
    expect(flat).toMatch(/… \+\d+ more/);                 // the task is elided, not dropped
  });

  it('shares the row budget between list and detail when stacked on a narrow terminal', () => {
    // Below MIN_TWO_COL the detail stacks UNDER the list instead of beside it, so the two stop overlapping
    // in the row budget and start adding up. Billing each the full capacity overflowed the frame, and the
    // overlay pays for an overrun out of the bottom rows — the detail block and the footer.
    const many: WorkflowState = {
      id: 'wf-n', toolCallId: 'call-n', title: 'wide dag', status: 'running',
      nodes: [
        { id: 'root', task: 'root task', status: 'done', deps: [], sessionId: 's-root' },
        ...Array.from({ length: 29 }, (_, i) => ({
          id: `node-${i}`, task: `task ${i}`, status: 'pending' as const, deps: ['root'],
        })),
      ],
    };
    let captured: { render(w: number): string[] } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 66, rows: 34 },
      } as never,
      editor: {} as never, getWorkflow: () => many, onDrill: vi.fn(),
    });
    const frame = captured!.render(62); // what the overlay constrains 66 columns down to
    show('modal — stacked on a narrow terminal', frame);

    const flat = frame.map(strip).join('\n');
    expect(flat).not.toContain('┼');                       // stacked, not two-column
    expect(frame.length).toBeLessThanOrEqual(30);          // modalGeometry's maxHeight at rows: 34
    expect(flat).toContain('enter open node transcript');  // footer survives
    expect(flat).toContain('root');                        // and so does the detail block
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
    let captured: { render(w: number): string[]; handleInput(d: string): void } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 100, rows: 40 },
      } as never,
      editor: {} as never, getWorkflow: () => hostile, onDrill: vi.fn(),
    });
    captured!.handleInput('\x1b[B'); // select `b`, whose deps render in the detail column
    const frame = captured!.render(90);
    expect(frame.join('\n')).not.toContain('\x1b[31m');
    expect(strip(frame.join('\n'))).toContain('deps: a, ghost');
  });

  it('keeps its OLED palette whatever theme the chat is on', () => {
    const frame = (): string[] => {
      let captured: { render(w: number): string[] } | null = null;
      openWorkflowModal({
        tui: {
          showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
          setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 100, rows: 40 },
        } as never,
        editor: {} as never, getWorkflow: () => WF, onDrill: vi.fn(),
      });
      return captured!.render(90);
    };
    setChatTheme('matrix');
    const onMatrix = frame();
    setChatTheme('elowen');
    const onElowen = frame();
    // Byte-identical: the modal is its own surface, so /theme must not reach inside it.
    expect(onMatrix).toEqual(onElowen);
    expect(onElowen.join('')).toContain('\x1b[48;2;0;0;0m'); // pure black, not the theme's modalBg
  });

  it('renders every row at exactly the frame width, in both layouts', () => {
    let captured: { render(w: number): string[] } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 120, rows: 40 },
      } as never,
      editor: {} as never, getWorkflow: () => WF, onDrill: vi.fn(),
    });
    // The one invariant that guards the whole column-join recipe: a cell padded with String.padEnd or an
    // un-truncated wrap would drift the row and tear the background.
    for (const width of [110, 90, 64, 56]) {
      for (const row of captured!.render(width)) {
        expect(visibleWidth(row)).toBe(width);
      }
    }
    show('modal — narrow fallback (56)', captured!.render(56));
    expect(captured!.render(56).map(strip).join('\n')).not.toContain('│'); // stacked, no divider
  });

  it('scrolls the list to keep the selection visible', () => {
    const big: WorkflowState = {
      id: 'wf-big', toolCallId: 'call-9', status: 'running',
      nodes: Array.from({ length: 30 }, (_, i) => ({
        id: `node-${i}`, task: `task ${i}`, status: 'pending' as const, deps: [],
      })),
    };
    let captured: { render(w: number): string[]; handleInput(d: string): void } | null = null;
    openWorkflowModal({
      tui: {
        showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
        setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 100, rows: 24 },
      } as never,
      editor: {} as never, getWorkflow: () => big, onDrill: vi.fn(),
    });
    const modal = captured!;
    for (let i = 0; i < 25; i += 1) modal.handleInput('\x1b[B');
    const flat = modal.render(90).map(strip).join('\n');
    expect(flat).toContain('node-25');
    expect(flat).not.toContain('node-0\n');
    expect(flat).toContain('↕'); // the range affordance appears once the list scrolls

    // ↑ from the first node wraps to the last — the window must follow that jump in one step.
    for (let i = 0; i < 25; i += 1) modal.handleInput('\x1b[A');
    modal.handleInput('\x1b[A');
    expect(modal.render(90).map(strip).join('\n')).toContain('node-29');
  });

  it('shows a full frame, not a broken one, when there is nothing to show', () => {
    const open = (getWorkflow: () => WorkflowState | undefined): string => {
      let captured: { render(w: number): string[] } | null = null;
      openWorkflowModal({
        tui: {
          showOverlay: (c: typeof captured) => { captured = c; return { hide: vi.fn(), focus: vi.fn() }; },
          setFocus: vi.fn(), requestRender: vi.fn(), terminal: { columns: 100, rows: 40 },
        } as never,
        editor: {} as never, getWorkflow, onDrill: vi.fn(),
      });
      return captured!.render(90).map(strip).join('\n');
    };
    expect(open(() => undefined)).toContain('no longer in the live view');
    expect(open(() => ({ ...WF, nodes: [] }))).toContain('still being built');
  });
});
