import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { TaskConversation } = await import('./TaskConversation');
import { createWrapper } from '../../../../web/tests/test-utils';

/** Build a stored `message` activity row (detail is JSON {role,text}, as eventStore.toRow writes it). */
const msg = (id: number, role: 'agent' | 'autopilot' | 'human', text: string, ts: string) =>
  ({ id, type: 'message', detail: JSON.stringify({ role, text }), ts });

describe('TaskConversation', () => {
  it('renders the worker↔autopilot message turns as a chronological thread', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['task-activity', 't1'], [
      msg(1, 'agent', 'Use Postgres or SQLite?', '2026-06-29 10:00:00'),
      msg(2, 'autopilot', 'SQLite — it matches the existing store.', '2026-06-29 10:01:00'),
    ]);
    client.setQueryData(['task-commits', 't1'], { commits: [] });
    render(<Wrapper><TaskConversation task={{ id: 't1' }} /></Wrapper>);

    expect(screen.getByText('Use Postgres or SQLite?')).toBeTruthy();
    expect(screen.getByText('SQLite — it matches the existing store.')).toBeTruthy();
    expect(screen.getByText('Agent asks')).toBeTruthy();
    expect(screen.getByText('Autopilot replies')).toBeTruthy();
  });

  it('labels a human reply distinctly from the autopilot', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['task-activity', 't2'], [
      msg(1, 'agent', '?', '2026-06-29 10:00:00'),
      msg(2, 'human', 'go with A', '2026-06-29 10:05:00'),
    ]);
    client.setQueryData(['task-commits', 't2'], { commits: [] });
    render(<Wrapper><TaskConversation task={{ id: 't2' }} /></Wrapper>);

    expect(screen.getByText('Your reply')).toBeTruthy();
    expect(screen.getByText('go with A')).toBeTruthy();
  });

  it('skips a malformed message detail without dropping the rest of the feed', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['task-activity', 't3'], [
      { id: 1, type: 'message', detail: '{not json', ts: '2026-06-29 10:00:00' },
      msg(2, 'autopilot', 'still here', '2026-06-29 10:01:00'),
    ]);
    client.setQueryData(['task-commits', 't3'], { commits: [] });
    render(<Wrapper><TaskConversation task={{ id: 't3' }} /></Wrapper>);

    expect(screen.getByText('still here')).toBeTruthy();
  });
});
