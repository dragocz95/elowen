import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu, DIVIDER, type MenuEntry } from '../../../components/ui/ContextMenu';

const state = (items: MenuEntry[]) => ({ x: 10, y: 10, items });

describe('ContextMenu', () => {
  it('renders actions, a divider and applies danger/disabled styling', () => {
    const items: MenuEntry[] = [
      { label: 'Edit', onClick: () => {} },
      DIVIDER,
      { label: 'Delete', onClick: () => {}, danger: true },
      { label: 'Locked', onClick: () => {}, disabled: true },
    ];
    render(<ContextMenu state={state(items)} onClose={() => {}} />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete').closest('button')).toHaveClass('text-danger');
    expect(screen.getByText('Locked').closest('button')).toBeDisabled();
  });

  it('running an action fires its onClick and closes the menu', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu state={state([{ label: 'Edit', onClick }])} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a submenu expands on hover and its item runs + closes the whole menu', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const items: MenuEntry[] = [
      { label: 'Set model', items: [{ label: 'Sonnet', onClick: onPick }, { label: 'Opus', onClick: () => {} }] },
    ];
    render(<ContextMenu state={state(items)} onClose={onClose} />);
    // Collapsed: the sub-item isn't shown yet.
    expect(screen.queryByText('Sonnet')).toBeNull();
    fireEvent.mouseEnter(screen.getByText('Set model').closest('div')!);
    expect(screen.getByText('Sonnet')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Sonnet'));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a disabled submenu does not expand on hover', () => {
    const items: MenuEntry[] = [{ label: 'Set model', disabled: true, items: [{ label: 'Sonnet', onClick: () => {} }] }];
    render(<ContextMenu state={state(items)} onClose={() => {}} />);
    fireEvent.mouseEnter(screen.getByText('Set model').closest('div')!);
    expect(screen.queryByText('Sonnet')).toBeNull();
  });

  it('Escape closes the menu', () => {
    const onClose = vi.fn();
    render(<ContextMenu state={state([{ label: 'Edit', onClick: () => {} }])} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders in the shared menu layer and supports arrow navigation', () => {
    render(<ContextMenu state={state([
      { label: 'Edit', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, danger: true },
    ])} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('overlay-layer-menu');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });
});
