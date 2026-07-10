import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectsProvider, resolveEffectsMode, useEffects } from '../../lib/useEffects';

type MediaListener = (event: MediaQueryListEvent) => void;

function Probe() {
  const { mode, resolvedMode, motionEnabled, ambientMotionEnabled, setMode } = useEffects();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolvedMode}</span>
      <span data-testid="motion">{String(motionEnabled)}</span>
      <span data-testid="ambient">{String(ambientMotionEnabled)}</span>
      <button onClick={() => setMode('full')}>full</button>
      <button onClick={() => setMode('reduced')}>reduced</button>
      <button onClick={() => setMode('off')}>off</button>
      <button onClick={() => setMode('auto')}>auto</button>
    </div>
  );
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<MediaListener>();
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    get matches() { return matches; },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.add(listener as MediaListener);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.delete(listener as MediaListener);
    },
    dispatchEvent: () => false,
  }) as MediaQueryList);

  return (next: boolean) => {
    matches = next;
    const event = { matches: next } as MediaQueryListEvent;
    listeners.forEach((listener) => listener(event));
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.setAttribute('data-effects-mode', 'auto');
  document.documentElement.setAttribute('data-effects', 'full');
});

afterEach(() => vi.restoreAllMocks());

describe('EffectsProvider', () => {
  it('requires a provider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useEffects must be used within EffectsProvider');
    errorSpy.mockRestore();
  });

  it('resolves auto from the OS preference and follows live changes', () => {
    const change = installMatchMedia(false);
    render(<EffectsProvider><Probe /></EffectsProvider>);
    expect(screen.getByTestId('mode')).toHaveTextContent('auto');
    expect(screen.getByTestId('resolved')).toHaveTextContent('full');

    act(() => change(true));
    expect(screen.getByTestId('resolved')).toHaveTextContent('reduced');
    expect(document.documentElement).toHaveAttribute('data-effects', 'reduced');
  });

  it('persists explicit reduced and off modes per device', () => {
    installMatchMedia(false);
    render(<EffectsProvider><Probe /></EffectsProvider>);

    fireEvent.click(screen.getByText('reduced'));
    expect(localStorage.getItem('elowen:effects')).toBe('reduced');
    expect(document.documentElement).toHaveAttribute('data-effects', 'reduced');
    expect(screen.getByTestId('motion')).toHaveTextContent('true');
    expect(screen.getByTestId('ambient')).toHaveTextContent('false');

    fireEvent.click(screen.getByText('off'));
    expect(localStorage.getItem('elowen:effects')).toBe('off');
    expect(document.documentElement).toHaveAttribute('data-effects', 'off');
    expect(screen.getByTestId('motion')).toHaveTextContent('false');
  });

  it('hydrates a stored preference and lets full override reduced OS motion', () => {
    localStorage.setItem('elowen:effects', 'full');
    installMatchMedia(true);
    render(<EffectsProvider><Probe /></EffectsProvider>);

    expect(screen.getByTestId('mode')).toHaveTextContent('full');
    expect(screen.getByTestId('resolved')).toHaveTextContent('full');
    expect(screen.getByTestId('ambient')).toHaveTextContent('true');
  });
});

describe('resolveEffectsMode', () => {
  it('only consults system motion for auto', () => {
    expect(resolveEffectsMode('auto', true)).toBe('reduced');
    expect(resolveEffectsMode('auto', false)).toBe('full');
    expect(resolveEffectsMode('off', false)).toBe('off');
  });
});
