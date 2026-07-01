import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '../../../components/ui/ThemeToggle';
import { createWrapper } from '../../test-utils';

beforeEach(() => localStorage.clear());

describe('ThemeToggle', () => {
  it('renders a single button reflecting the active mode and cycles system → light → dark on click', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ThemeToggle /></Wrapper>);

    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toContain('System');

    fireEvent.click(btn); // system -> light
    expect(localStorage.getItem('orca:theme')).toBe('light');
    expect(btn.getAttribute('aria-label')).toContain('Light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(btn); // light -> dark
    expect(localStorage.getItem('orca:theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toContain('Dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(btn); // dark -> system (wraps around)
    expect(localStorage.getItem('orca:theme')).toBe('system');
    expect(btn.getAttribute('aria-label')).toContain('System');
  });
});
