import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ActionMenu, type ActionMenuItem } from '../../../components/ui/ActionMenu';

/** A neighbouring control is part of every case here: this menu opens on HOVER, so what it must not do
 *  to the rest of the page is as much of its contract as what it does itself. */
const renderMenu = (items: ActionMenuItem[]) => render(
  <LanguageProvider>
    <input aria-label="Filter" />
    <ActionMenu label="Row actions" items={items} />
  </LanguageProvider>,
);

const rows: ActionMenuItem[] = [
  { label: 'Open', onSelect: vi.fn() },
  { label: 'Edit', onSelect: vi.fn() },
  { label: 'Delete', onSelect: vi.fn(), tone: 'danger' },
];

describe('ActionMenu', () => {
  it('opens on hover in place, without taking focus from what the reader was doing', async () => {
    const { container } = renderMenu([{ label: 'Open', onSelect: vi.fn() }]);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    const filter = screen.getByRole('textbox', { name: 'Filter' });
    filter.focus();

    fireEvent.mouseEnter(trigger);

    const panel = await screen.findByRole('menu');
    expect(panel).toHaveClass('overlay-layer-menu');
    // Rendered where it was written, NOT portaled to <body>: this app marks every other child of
    // <body> inert when an overlay opens, so a portaled menu is one the focus trap pushes out of.
    expect(container).toContainElement(panel);
    // A pointer merely crossing the trigger must not pull focus out of the field being typed in —
    // Radix focuses a menu the moment it opens, and this is the seam that says "not for a hover".
    expect(filter).toHaveFocus();

    fireEvent.mouseLeave(trigger);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(filter).toHaveFocus();
  });

  it('supports the menu-button keyboard pattern and restores trigger focus on activation', async () => {
    const onOpen = vi.fn();
    renderMenu([{ ...rows[0]!, onSelect: onOpen }, rows[1]!, rows[2]!]);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Open' }), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit' }), { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Open' }), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it('opens at the LAST row on ArrowUp, and Escape closes it back onto the trigger', async () => {
    renderMenu(rows);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    trigger.focus();

    // The other half of the menu-button pattern: ArrowUp opens looking at the bottom of the list.
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
