import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UiScaleProvider, useUiScale } from '../../lib/useUiScale';

function Probe() {
  const { scale, preference, setPreference } = useUiScale();
  return <button onClick={() => setPreference(1.2)}>applied:{scale} pref:{preference}</button>;
}

function widen(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}
const resizeTo = (width: number) => act(() => { widen(width); window.dispatchEvent(new Event('resize')); });

// jsdom doesn't store the non-standard `zoom` property, so assert the applier *call* instead.
let setSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  widen(1920);
  setSpy = vi.spyOn(document.documentElement.style, 'setProperty');
});
afterEach(() => setSpy.mockRestore());

describe('useUiScale', () => {
  it('defaults to a neutral preference and applies the zoom to the document root', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByText('applied:1 pref:1')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1');
  });

  it('setPreference updates state, zoom, the --ui-scale var and localStorage', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    fireEvent.click(screen.getByText('applied:1 pref:1'));
    expect(screen.getByText('applied:1.2 pref:1.2')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1.2');
    expect(setSpy).toHaveBeenCalledWith('--ui-scale', '1.2'); // full-height layout divides by this
    expect(localStorage.getItem('elowen:ui-scale')).toBe('1.2');
  });

  it('hydrates a persisted preference on mount', () => {
    localStorage.setItem('elowen:ui-scale', '1.35');
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByText('applied:1.35 pref:1.35')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1.35');
  });

  it('clamps an out-of-range preference to the allowed bounds', () => {
    function Clamp() {
      const { preference, setPreference } = useUiScale();
      return <button onClick={() => setPreference(9)}>v:{preference}</button>;
    }
    render(<UiScaleProvider><Clamp /></UiScaleProvider>);
    fireEvent.click(screen.getByText('v:1'));
    expect(screen.getByText('v:1.5')).toBeTruthy(); // MAX_SCALE
  });

  // The regression this file exists for. An automatic width-derived factor used to multiply in here, and
  // it was discontinuous by construction: it exempted phones and shrank everything else, so 767px
  // rendered at 100% and 768px at 70% — one pixel of window travel flipping the app from a phone layout
  // at full size to a desktop layout at 70%, with every tablet and 1280/1366 laptop parked on the floor.
  // Fitting the design to the window is the stylesheet's job; the zoom answers to the slider alone.
  it('never scales itself from the window width — at any width the applied zoom is the preference', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    for (const width of [390, 767, 768, 1024, 1280, 1366, 1440, 1600, 1900, 2560]) {
      resizeTo(width);
      expect(screen.getByText('applied:1 pref:1')).toBeTruthy();
    }
    expect(setSpy).not.toHaveBeenCalledWith('zoom', expect.not.stringMatching(/^1$/));
  });

  it('keeps a chosen preference across a resize', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    fireEvent.click(screen.getByText('applied:1 pref:1'));
    resizeTo(768);
    expect(screen.getByText('applied:1.2 pref:1.2')).toBeTruthy();
  });
});
