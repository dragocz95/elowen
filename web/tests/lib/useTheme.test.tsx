import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../lib/useTheme';

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={() => setTheme('dark')}>set-dark</button>
    </div>
  );
}

function mockMatchMedia(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.restoreAllMocks());

describe('useTheme / ThemeProvider', () => {
  it('throws outside a provider', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useTheme must be used within ThemeProvider');
    errSpy.mockRestore();
  });

  it('defaults to system and applies the resolved theme to <html data-theme>', () => {
    mockMatchMedia(false); // OS reports light
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('resolves the system theme via prefers-color-scheme', () => {
    mockMatchMedia(true); // OS reports dark
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setTheme persists to localStorage and updates data-theme', () => {
    mockMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('orca:theme')).toBe('dark');
  });

  it('hydrates a persisted theme on mount, overriding the system preference', () => {
    localStorage.setItem('orca:theme', 'light');
    mockMatchMedia(true); // system says dark, but the persisted explicit choice wins
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('does not flash dark when a persisted light theme meets a dark OS preference', () => {
    localStorage.setItem('orca:theme', 'light');
    mockMatchMedia(true); // OS prefers dark
    // Simulate the no-flash script in app/layout.tsx, which paints the resolved palette before React mounts.
    document.documentElement.setAttribute('data-theme', 'light');
    const setAttributeSpy = vi.spyOn(document.documentElement, 'setAttribute');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    const dataThemeWrites = setAttributeSpy.mock.calls.filter(([name]) => name === 'data-theme').map(([, value]) => value);
    expect(dataThemeWrites).not.toContain('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
