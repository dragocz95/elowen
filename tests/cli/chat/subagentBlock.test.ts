import { describe, expect, it, beforeAll } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import type { ChatTurn, ToolItem, SubagentState } from '../../../src/brain/transcript.js';

beforeAll(() => { initTheme(); });

const CHILD = 'brain-ch-subagent-sub-dlg-abc';

const delegation = (over: Partial<SubagentState> = {}): SubagentState => ({
  sessionId: CHILD, status: 'running', task: 'Audit the delegation rail', name: 'rail audit',
  tools: 18, seconds: 900, model: 'deepseek-v4-flash', ...over,
});

const turnOf = (name: string, sub: SubagentState): ChatTurn => ({
  role: 'elowen', streaming: false,
  segments: [{ kind: 'tools', items: [{ name, id: 'call-1', sub } satisfies ToolItem] }],
});

const render = (turn: ChatTurn): string =>
  new TurnRenderer(getMarkdownTheme())
    .render(turn, 0, 96, { showThoughts: true, thinkingSeconds: 0, composingMarkerReady: false, spinnerFrame: 0, expandedThoughts: new Set(), expandedTools: new Set() })
    .map((row) => row.line)
    // eslint-disable-next-line no-control-regex
    .join('\n').replace(/\x1b\[[0-9;]*m/g, '');

// A DelegateContinue sent to a sub-agent that is still mid-turn is STEERED into that running turn: the
// call returns at once, having run no tools, while the delegation it entered keeps working. Rendered like
// any settled run it read "✓ Sub-agent … · 0 tools · 10s" — a finished sub-agent that was not finished.
describe('the sub-agent block of a steered continuation', () => {
  it('renders as a steer, not as a run that finished', () => {
    const body = render(turnOf('DelegateContinue', delegation({
      status: 'done', name: 'check the tally', task: 'also check the tally', tools: 0, seconds: 10, model: undefined, steered: true,
    })));

    expect(body).toContain('→');
    expect(body).toContain('steered');
    expect(body).not.toContain('✓');
    // The tallies of a call that ran nothing are exactly what made the row read as a completed run.
    expect(body).not.toContain('0 tools');
    expect(body).not.toContain('10s');
  });

  it('still drills into the child it steered into', () => {
    const rows = new TurnRenderer(getMarkdownTheme())
      .render(turnOf('DelegateContinue', delegation({ status: 'done', tools: 0, seconds: 10, steered: true })), 0, 96, {
        showThoughts: true, thinkingSeconds: 0, composingMarkerReady: false, spinnerFrame: 0, expandedThoughts: new Set(), expandedTools: new Set(),
      });
    const clickable = rows.filter((row) => row.kind === 'subagent');
    expect(clickable.length).toBeGreaterThan(0);
    for (const row of clickable) expect(row.key).toBe(CHILD);
  });

  // The original delegation is untouched: its own row keeps showing the live run the steer entered.
  it('leaves an ordinary delegation row reading as the run it is', () => {
    const running = render(turnOf('Delegate', delegation({ detail: 'Reading config…' })));
    expect(running).toContain('●');
    expect(running).toContain('Reading config…');
    expect(running).not.toContain('steered');

    const finished = render(turnOf('Delegate', delegation({ status: 'done' })));
    expect(finished).toContain('✓');
    expect(finished).toContain('18 tools');
    expect(finished).not.toContain('steered');
  });
});
