import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ThemeToggle } from '../../../components/ui/ThemeToggle';
import { createWrapper } from '../../test-utils';

beforeEach(() => localStorage.clear());

describe('ThemeToggle', () => {
  it('renders a radiogroup with the current theme checked and switches theme on click', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ThemeToggle /></Wrapper>);

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(group).getByRole('radio', { name: 'Light' }));

    expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('orca:theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('collapsed variant renders a single button that cycles through modes on click', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ThemeToggle collapsed /></Wrapper>);

    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toContain('System');

    fireEvent.click(btn); // system -> light
    expect(localStorage.getItem('orca:theme')).toBe('light');
    expect(btn.getAttribute('aria-label')).toContain('Light');

    fireEvent.click(btn); // light -> dark
    expect(localStorage.getItem('orca:theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toContain('Dark');
  });
});
