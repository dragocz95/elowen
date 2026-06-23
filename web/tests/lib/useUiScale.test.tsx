import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UiScaleProvider, useUiScale } from '../../lib/useUiScale';

function Probe() {
  const { scale, setScale } = useUiScale();
  return <button onClick={() => setScale(1.2)}>scale:{scale}</button>;
}

// jsdom doesn't store the non-standard `zoom` property, so assert the applier *call* instead.
let setSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { localStorage.clear(); setSpy = vi.spyOn(document.documentElement.style, 'setProperty'); });
afterEach(() => setSpy.mockRestore());

describe('useUiScale', () => {
  it('defaults to 1 and applies zoom to the document root', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByText('scale:1')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1');
  });

  it('setScale updates state, zoom and localStorage', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    fireEvent.click(screen.getByText('scale:1'));
    expect(screen.getByText('scale:1.2')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1.2');
    expect(localStorage.getItem('orca:ui-scale')).toBe('1.2');
  });

  it('hydrates a persisted value on mount', () => {
    localStorage.setItem('orca:ui-scale', '1.35');
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByText('scale:1.35')).toBeTruthy();
    expect(setSpy).toHaveBeenCalledWith('zoom', '1.35');
  });

  it('clamps out-of-range values to the allowed bounds', () => {
    function Clamp() {
      const { scale, setScale } = useUiScale();
      return <button onClick={() => setScale(9)}>v:{scale}</button>;
    }
    render(<UiScaleProvider><Clamp /></UiScaleProvider>);
    fireEvent.click(screen.getByText('v:1'));
    expect(screen.getByText('v:1.5')).toBeTruthy(); // MAX_SCALE
  });
});
