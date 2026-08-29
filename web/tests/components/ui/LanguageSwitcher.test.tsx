import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher';
import { createWrapper } from '../../test-utils';

beforeEach(() => localStorage.clear());

const openByPointer = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

describe('LanguageSwitcher', () => {
  it('opens the menu and lists all languages', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    openByPointer(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('English')).toBeInTheDocument();
    expect(within(menu).getByText('Čeština')).toBeInTheDocument();
    expect(within(menu).getByText('Slovenčina')).toBeInTheDocument();
  });

  it('selects a locale via setLocale, persists it and closes the menu', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    openByPointer(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));

    expect(localStorage.getItem('elowen-locale')).toBe('cs');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on outside pointer press', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper>
        <div>
          <LanguageSwitcher />
          <button>outside</button>
        </div>
      </Wrapper>,
    );

    openByPointer(screen.getByRole('button', { name: /Language/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.pointerDown(screen.getByText('outside'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);
    const trigger = screen.getByRole('button');
    trigger.focus();

    openByPointer(trigger);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('supports keyboard opening, arrow navigation and Enter selection', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);
    const trigger = screen.getByRole('button');
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const english = await screen.findByRole('menuitemradio', { name: 'English' });
    await waitFor(() => expect(english).toHaveFocus());

    fireEvent.keyDown(english, { key: 'ArrowDown' });
    const czech = screen.getByRole('menuitemradio', { name: 'Čeština' });
    await waitFor(() => expect(czech).toHaveFocus());
    fireEvent.keyDown(czech, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(localStorage.getItem('elowen-locale')).toBe('cs');
    expect(trigger).toHaveFocus();
  });

  // The collapsed button is what the top bar renders on a phone. It used to also move the menu
  // sideways and bottom-align it (a leftover from a sidebar-footer mount that no longer exists),
  // which pushed the menu off the right edge of a phone screen — the language became unreachable.
  it('drops the menu below the button even when collapsed, never sideways', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher collapsed /></Wrapper>);

    openByPointer(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-side', 'bottom');
    expect(menu).toHaveAttribute('data-align', 'end');
  });

  it('positions the menu the same way when not collapsed', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    openByPointer(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-side', 'bottom');
    expect(menu).toHaveAttribute('data-align', 'end');
  });
});
