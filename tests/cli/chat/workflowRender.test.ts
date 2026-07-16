import { describe, it, expect, vi } from 'vitest';
import { WorkflowPanel } from '../../../src/cli/chat/components.js';
import { openWorkflowModal } from '../../../src/cli/chat/workflowModal.js';
import type { WorkflowState } from '../../../src/brain/transcript.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
const show = (label: string, lines: string[]): void => {
  // Print the rendered frame so the CLI layout can be eyeballed in test output (a deterministic stand-in
  // for the TMUX visual check — the daemon model was out of credit at authoring time).
  console.log(`\n──── ${label} ────`);
  for (const line of lines) console.log(strip(line));
};

const WF: WorkflowState = {
  id: 'wf-1', title: 'ship the parser', status: 'running',
  nodes: [
    { id: 'gather', task: 'Read the parser sources and summarize the token grammar', status: 'done', deps: [], sessionId: 's-gather', tokens: 4200, seconds: 9, model: 'claude-opus-4-8' },
    { id: 'analyze', task: 'Find every edge case the grammar misses', status: 'running', deps: ['gather'], sessionId: 's-analyze', tokens: 1800, seconds: 5, detail: 'read_file src/lexer.ts', model: 'claude-opus-4-8' },
    { id: 'write', task: 'Write the fix and a regression test', status: 'pending', deps: ['analyze'] },
  ],
};

describe('workflow CLI rendering', () => {
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
      terminal: { columns: 100 },
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
    expect(flat0).toContain('deps: gather'); // analyze's dependency shown
    expect(flat0).toContain('enter open node transcript'); // selected node has a session

    // Arrow down twice → the pending 'write' node (no session) → the hint changes.
    modal.handleInput('\x1b[B');
    modal.handleInput('\x1b[B');
    const frame2 = modal.render(90);
    show('modal — node "write" selected (pending)', frame2);
    expect(frame2.map(strip).join('\n')).toContain('node not started');

    // Enter on a started node drills into its session.
    modal.handleInput('\x1b[A'); // back up to 'analyze' (has a session)
    modal.handleInput('\r');
    expect(onDrill).toHaveBeenCalledWith('s-analyze');
  });
});
