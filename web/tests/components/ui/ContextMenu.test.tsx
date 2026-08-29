import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContextMenu, DIVIDER, type MenuEntry } from '../../../components/ui/ContextMenu';

const state = (items: MenuEntry[]) => ({ x: 10, y: 10, items });

/** The menu opens from a replayed right-click, so every case has to wait for it — Radix renders rows
 *  only while the menu is open, and a query against a closed one finds nothing. */
const openMenu = (items: MenuEntry[], onClose = () => {}) => {
  const view = render(<ContextMenu state={state(items)} onClose={onClose} />);
  return { ...view, menu: screen.findByRole('menu') };
};

describe('ContextMenu', () => {
  it('renders actions, a divider and marks the destructive and disabled rows', async () => {
    const items: MenuEntry[] = [
      { label: 'Edit', onClick: () => {} },
      DIVIDER,
      { label: 'Delete', onClick: () => {}, danger: true },
      { label: 'Locked', onClick: () => {}, disabled: true },
    ];
    await openMenu(items).menu;

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-variant', 'destructive');
    expect(screen.getByRole('menuitem', { name: 'Locked' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('running an action fires its onClick and closes the menu', async () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    await openMenu([{ label: 'Edit', onClick }], onClose).menu;

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('a submenu expands on click and its item runs + closes the whole menu', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const items: MenuEntry[] = [
      { label: 'Set model', items: [{ label: 'Sonnet', onClick: onPick }, { label: 'Opus', onClick: () => {} }] },
    ];
    await openMenu(items, onClose).menu;

    // Collapsed: the sub-item isn't rendered yet.
    expect(screen.queryByRole('menuitem', { name: 'Sonnet' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set model' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }));
    expect(onPick).toHaveBeenCalledOnce();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('a disabled submenu does not expand', async () => {
    const items: MenuEntry[] = [{ label: 'Set model', disabled: true, items: [{ label: 'Sonnet', onClick: () => {} }] }];
    await openMenu(items).menu;

    fireEvent.click(screen.getByRole('menuitem', { name: 'Set model' }));

    expect(screen.queryByRole('menuitem', { name: 'Sonnet' })).toBeNull();
  });

  it('Escape closes the menu', async () => {
    const onClose = vi.fn();
    const menu = await openMenu([{ label: 'Edit', onClick: () => {} }], onClose).menu;

    fireEvent.keyDown(menu, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('renders in the shared menu layer, in place, and moves the highlight with the arrow keys', async () => {
    const { container, menu: pending } = openMenu([
      { label: 'Edit', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, danger: true },
    ]);
    const menu = await pending;

    expect(menu).toHaveClass('overlay-layer-menu');
    // Not portaled to <body>: this menu is opened from inside dialogs whose background isolation marks
    // every other child of <body> inert, which is exactly where a portal would have put it.
    expect(container).toContainElement(menu);

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit' }), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus());
  });
});
