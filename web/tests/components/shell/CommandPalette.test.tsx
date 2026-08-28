import { describe, it, expect, vi, beforeAll } from 'vitest';
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
import { CommandPalette, COMMAND_PALETTE_OPEN_EVENT } from '../../../components/shell/CommandPalette';

// jsdom implements no scrollIntoView, and the palette keeps the active row in view — that is the whole
// point of wrapping past the ends of a list taller than its scroller.
beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });

const openPalette = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

describe('CommandPalette', () => {
  // The searched destination is a PLUGIN page: the board left the core registry with the work plugin,
  // and a palette that only walked MODULES would have quietly stopped being able to reach it.
  it('opens on Ctrl+K, filters, and runs a command on Enter', () => {
    render(<CommandPalette />, { wrapper: W });
    expect(screen.queryByPlaceholderText('Search commands…')).not.toBeInTheDocument();
    openPalette();
    const input = screen.getByPlaceholderText('Search commands…');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'kanban' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/p/work/kanban');
  });

  // TopBar's visible trigger dispatches exactly this event, and it is the only way a pointer user reaches
  // the palette at all — a design that ships the button must not ship it dead.
  it('opens on the window event and hands focus to the search field', () => {
    render(<CommandPalette />, { wrapper: W });
    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    expect(screen.getByPlaceholderText('Search commands…')).toHaveFocus();
  });

  // The palette used to be a bare <input> over a <ul> of <button>s: no combobox, no listbox, no announced
  // active row, so a screen reader was told nothing about what Enter would run.
  it('exposes a combobox over a listbox and announces the active option', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const input = screen.getByRole('combobox', { name: 'Search commands…' });
    const list = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-expanded', 'true');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  // Wraparound is what SelectMenu — the app's reference listbox — does, so the palette does it too.
  it('wraps the cursor past both ends of the list', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const input = screen.getByRole('combobox', { name: 'Search commands…' });
    const options = screen.getAllByRole('option');
    const last = options.at(-1)!.id;

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', last);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
  });

  // It now goes through useDialogOverlay like every other overlay: Escape from the stack, the background
  // isolated while it is up, and focus returned to whatever opened it.
  it('isolates the background and restores focus to the opener on close', () => {
    const { container } = render(<CommandPalette />, { wrapper: W });
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    expect(container.closest('body > *')).toHaveAttribute('inert');
    expect(opener).toHaveAttribute('inert');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(opener).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
