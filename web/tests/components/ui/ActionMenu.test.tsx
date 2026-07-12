import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ActionMenu } from '../../../components/ui/ActionMenu';

describe('ActionMenu', () => {
  afterEach(() => document.documentElement.style.removeProperty('--ui-scale'));

  it('anchors its right edge to the trigger when UI zoom is active', () => {
    document.documentElement.style.setProperty('--ui-scale', '1.25');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    render(
      <LanguageProvider>
        <ActionMenu label="Row actions" items={[{ label: 'Open', onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    trigger.getBoundingClientRect = () => ({ x: 770, y: 68, left: 770, top: 68, right: 800, bottom: 100, width: 30, height: 32, toJSON: () => ({}) });

    fireEvent.mouseEnter(trigger);

    expect(screen.getByRole('menu')).toHaveStyle({ right: '160px' });
  });

  it('supports the menu-button keyboard pattern and restores trigger focus', () => {
    const onOpen = vi.fn();
    render(
      <LanguageProvider>
        <ActionMenu label="Row actions" items={[
          { label: 'Open', onSelect: onOpen },
          { label: 'Edit', onSelect: vi.fn() },
          { label: 'Delete', onSelect: vi.fn(), tone: 'danger' },
        ]} />
      </LanguageProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
