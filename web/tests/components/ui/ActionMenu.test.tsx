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

describe('ActionMenu kebab variant', () => {
  const renderKebab = () => render(
    <LanguageProvider>
      <input aria-label="Filter" />
      <ActionMenu variant="kebab" label="Row actions" items={rows} />
    </LanguageProvider>,
  );

  it('does NOT open on hover, whatever the pointer is doing on its way past', async () => {
    // The reason the variant exists. A register row is a thing the pointer crosses on its way somewhere
    // else, and a panel that drops open under the cursor covers the rows below the one being read.
    renderKebab();
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    fireEvent.mouseEnter(trigger);
    // Long enough to outlast the hover grace period the destructive variant opens within.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click and keeps the whole keyboard contract', async () => {
    renderKebab();
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    fireEvent.pointerDown(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    // Click-only must not mean pointer-only: the menu-button pattern still answers the keyboard.
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Open' }), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('is a neutral 32×32 square, never the destructive fill', () => {
    renderKebab();
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger.className).toContain('h-8');
    expect(trigger.className).toContain('w-8');
    expect(trigger.className).toContain('rounded-md');
    // A red button in every row shouts the one action a reader is least likely to want.
    expect(trigger.className).not.toContain('bg-destructive');
    expect(trigger.className).toContain('text-muted-foreground');
  });

  it('leaves the destructive default exactly as it was', async () => {
    // The variant is an addition. Every existing caller passes nothing and must keep its red trigger and
    // its hover behaviour.
    renderMenu([{ label: 'Open', onSelect: vi.fn() }]);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger.className).toContain('bg-destructive');
    fireEvent.mouseEnter(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('still lets a caller ask for hover explicitly', async () => {
    render(
      <LanguageProvider>
        <ActionMenu variant="kebab" openOnHover label="Row actions" items={rows} />
      </LanguageProvider>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Row actions' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});

describe('menu panel geometry', () => {
  it('sets the panel at radius 10 with 6px of padding, and its rows at 32px', async () => {
    renderMenu(rows);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Row actions' }));
    const panel = await screen.findByRole('menu');
    expect(panel.className).toContain('rounded-md');
    expect(panel.className).toContain('p-1.5');
    // 20px of line box plus 6px above and below. The previous 8px made a three-item menu 12px taller
    // than the reference's without carrying any more information.
    expect(screen.getByRole('menuitem', { name: 'Open' }).className).toContain('py-1.5');
  });
});
