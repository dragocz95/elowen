import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
import { Modal } from '../../../components/ui/Modal';

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
  //
  // The marker is asserted alongside the focus because Radix would otherwise cover for its absence: its
  // own `onOpenAutoFocus` default focuses the first TABBABLE control, which here happens to be this same
  // input (the rows are held at `tabIndex={-1}`). Focus landing correctly therefore does not prove the
  // app's policy still runs; `data-autofocus` being on the element it aims at is what does.
  it('opens on the window event and hands focus to the search field', () => {
    render(<CommandPalette />, { wrapper: W });
    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    const input = screen.getByPlaceholderText('Search commands…');
    expect(input).toHaveAttribute('data-autofocus');
    expect(input).toHaveFocus();
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

  // The dialog is Radix's now, so it has to BE one: an announced modal dialog whose surface sits inside
  // the layer that isolates the page — not a second body child of its own, which is what Radix's
  // `Dialog.Portal` would produce and what the overlay stack would then mark inert.
  it('renders the palette as a modal dialog inside the isolating layer', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();

    const dialog = screen.getByRole('dialog', { name: 'Open command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toHaveClass('overlay-layer-modal');
    expect(dialog.closest('[inert]')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Search commands…' }).closest('[role="dialog"]')).toBe(dialog);
  });

  // Radix owns the focus trap and Escape; the app keeps the overlay stack's `inert` isolation and the
  // element to hand focus back to, because Radix has no notion of either — a dialog mounted without a
  // `Dialog.Trigger` leaves it nothing to restore focus to.
  //
  // Escape is raised on the DIALOG, not on `window`: Radix listens on the document, which is where a real
  // keypress arrives after bubbling out of whatever had focus. `window` is one step further up and nothing
  // propagates back down to it.
  it('isolates the background and restores focus to the opener on close', async () => {
    const { container } = render(<CommandPalette />, { wrapper: W });
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    expect(container.closest('body > *')).toHaveAttribute('inert');
    expect(opener).toHaveAttribute('inert');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Open command palette' }), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(opener).not.toHaveAttribute('inert');
    // Radix's focus scope hands focus back a tick after the surface is gone, so that its own trap is
    // already torn down and cannot pull the restored focus back into the dialog it is unmounting.
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  // Escape belongs to the TOPMOST overlay only, which is why `CommandPalette` deliberately does not handle
  // it in its own window listener: an overlay raised over the palette has to dismiss itself first and
  // leave the palette standing. That used to be the overlay stack's rule and is now the Radix layer
  // stack's, so it is asserted across the two rather than assumed to have survived the move.
  it('leaves Escape to an overlay raised over it', () => {
    const onRaisedClose = vi.fn();
    function Harness({ raised }: { raised: boolean }) {
      return (
        <>
          <CommandPalette />
          {raised ? <Modal title="Raised dialog" onClose={onRaisedClose}>raised</Modal> : null}
        </>
      );
    }
    // Mounted only after the palette is up, so it really is the layer above it rather than below.
    const { rerender } = render(<Harness raised={false} />, { wrapper: W });
    openPalette();
    rerender(<Harness raised />);

    fireEvent.keyDown(document.querySelector('[data-elowen-modal]')!, { key: 'Escape' });
    expect(onRaisedClose).toHaveBeenCalledTimes(1);
    // Queried through the DOM: the stack correctly takes the palette out of the accessibility tree while
    // it is not the topmost overlay, which is the same rule that just kept Escape away from it.
    expect(document.querySelector('[role="dialog"][aria-label="Open command palette"]')).toBeInTheDocument();
  });

  // A `click` fires on the common ancestor of the press and the release, so a press that begins on a row
  // and ends anywhere else reaches the backdrop with `target === currentTarget`. Radix Select makes that
  // the normal case rather than an edge one — opening it sets `pointer-events: none` on the body — so the
  // backdrop dismisses only on a press that BEGAN on it.
  it('closes on a backdrop press but not on one that began inside the panel', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const backdrop = screen.getByRole('dialog', { name: 'Open command palette' }).parentElement!;

    fireEvent.pointerDown(screen.getAllByRole('option')[0]!);
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog', { name: 'Open command palette' })).toBeInTheDocument();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Open command palette' })).not.toBeInTheDocument();
  });
});
