import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: () => {} }) }));
// The palette gates its "New mission" action on the agents plugin's presence, and lists the pages of
// every enabled plugin alongside the core modules; this suite runs without a QueryClient, so stub both
// hooks directly.
vi.mock('../../../lib/queries', () => ({
  useAgentsPlugin: () => true,
  useWorkPlugin: () => true,
  usePluginUi: () => ({ data: [{
    name: 'work',
    nav: [
      { label: 'Tasks', icon: 'ListChecks', route: 'tasks' },
      { label: 'Kanban', icon: 'KanbanSquare', route: 'kanban' },
    ],
    settings: [],
  }] }),
}));
import { CommandPalette } from '../../../components/shell/CommandPalette';

describe('CommandPalette', () => {
  // The searched destination is a PLUGIN page: the board left the core registry with the work plugin,
  // and a palette that only walked MODULES would have quietly stopped being able to reach it.
  it('opens on Ctrl+K, filters, and runs a command on Enter', () => {
    render(<CommandPalette />, { wrapper: W });
    expect(screen.queryByPlaceholderText('Search commands…')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('Search commands…');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'kanban' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/p/work/kanban');
  });
});
