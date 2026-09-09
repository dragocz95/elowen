import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper, setViewport } from '../../test-utils';
import { AgentsTable } from '../../../modules/advisor/AgentsTable';
import type { SubagentState } from '../../../lib/transcript';

// A DelegateContinue sent to a sub-agent that is still mid-turn is STEERED into that running turn: the
// call enters its context and returns at once, with no tools and no run of its own. The agents table folds
// one row per child, so once every call on the child settles this is the row that speaks for it — and as
// an ordinary "done · 0 tools · 10s" row it reported a run that never happened.
const steered: SubagentState = {
  sessionId: 'brain-ch-subagent-sub-dlg-abc', status: 'done', task: 'also check the tally',
  name: 'check the tally', tools: 0, seconds: 10, steered: true,
};

const finished: SubagentState = {
  sessionId: 'brain-ch-subagent-sub-dlg-xyz', status: 'done', task: 'Audit the delegation rail',
  name: 'rail audit', tools: 18, seconds: 900, model: 'deepseek-v4-flash',
};

const row = (sessionId: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-agent-session="${sessionId}"]`);
  if (!found) throw new Error(`no row for ${sessionId}`);
  return found;
};

describe('AgentsTable with a steered continuation', () => {
  beforeEach(() => { setViewport(false); });

  it('reads as a steer, not as a run that finished', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AgentsTable agents={[steered]} onOpen={() => {}} onClose={() => {}} /></Wrapper>);

    const cells = row(steered.sessionId).textContent ?? '';
    expect(cells).toContain('steered');
    expect(cells).not.toContain('done');
    // The tallies of a call that ran nothing are what made the row read as a completed run.
    expect(cells).not.toContain('10s');
    expect(cells).not.toContain('0 tools');
  });

  it('leaves an ordinary finished delegation reading as the run it was', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AgentsTable agents={[finished]} onOpen={() => {}} onClose={() => {}} /></Wrapper>);

    const cells = row(finished.sessionId).textContent ?? '';
    expect(cells).toContain('done');
    expect(cells).toContain('18');
    expect(cells).not.toContain('steered');
    expect(screen.getByText('Audit the delegation rail')).toBeTruthy();
  });
});
