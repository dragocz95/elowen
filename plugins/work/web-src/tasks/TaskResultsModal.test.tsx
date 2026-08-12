import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { TaskResultsModal } = await import('./TaskResultsModal');
import { createWrapper } from '../../../../web/tests/test-utils';
import type { Task } from '../types';

const closedTask: Task = {
  id: 'elowen-ab12cd34',
  title: 'Add CSV export',
  status: 'closed',
  type: 'feature',
  outcome: 'ok',
  result_summary: 'Implemented CSV export and added tests.',
  labels: ['exec:sonnet', 'agent:nova'],
  created_at: '2026-06-18 10:00:00',
  closed_at: '2026-06-18 10:03:30',
};

describe('TaskResultsModal', () => {
  it('shows the result summary, outcome and a finished/duration view for a closed task', () => {
    const { wrapper } = createWrapper();
    render(<TaskResultsModal task={closedTask} onClose={() => {}} />, { wrapper });
    expect(screen.getByText('Add CSV export')).toBeInTheDocument();
    expect(screen.getByText('Implemented CSV export and added tests.')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    // run lasted 3m 30s
    expect(screen.getByText('3m 30s')).toBeInTheDocument();
  });

  it('falls back to a no-summary note when the task closed without one', () => {
    const { wrapper } = createWrapper();
    render(<TaskResultsModal task={{ ...closedTask, result_summary: null }} onClose={() => {}} />, { wrapper });
    expect(screen.getByText('Closed without a summary.')).toBeInTheDocument();
  });

  it('closes via the footer button', () => {
    const onClose = vi.fn();
    const { wrapper } = createWrapper();
    render(<TaskResultsModal task={closedTask} onClose={onClose} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
