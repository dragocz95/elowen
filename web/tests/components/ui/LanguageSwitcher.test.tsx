import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher';
import { createWrapper } from '../../test-utils';

beforeEach(() => localStorage.clear());

describe('LanguageSwitcher', () => {
  it('opens the menu and lists both languages', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('English')).toBeInTheDocument();
    expect(within(menu).getByText('Čeština')).toBeInTheDocument();
  });

  it('selects a locale via setLocale, persists it and closes the menu', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Čeština' }));

    expect(localStorage.getItem('orca-locale')).toBe('cs');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on outside click', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper>
        <div>
          <LanguageSwitcher />
          <button>outside</button>
        </div>
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Language/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the collapsed menu inward (right-full) when side is right', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><LanguageSwitcher collapsed side="right" /></Wrapper>);

    fireEvent.click(screen.getByRole('button'));

    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('right-full');
    expect(menu.className).not.toContain('left-full');
  });
});
