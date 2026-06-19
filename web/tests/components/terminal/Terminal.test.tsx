import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const writeSpy = vi.fn(); const clearSpy = vi.fn(); const openSpy = vi.fn(); const disposeSpy = vi.fn();
const fitSpy = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open = openSpy; write = writeSpy; clear = clearSpy; dispose = disposeSpy; loadAddon = vi.fn(); },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = fitSpy; } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeES { static last: FakeES; listeners: Record<string, (e: { data: string }) => void> = {}; close() {} constructor(public url: string) { FakeES.last = this; } addEventListener(t: string, fn: (e: { data: string }) => void) { this.listeners[t] = fn; } emit(t: string, d: unknown) { this.listeners[t]?.({ data: JSON.stringify(d) }); } }
beforeEach(() => { (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES; writeSpy.mockClear(); clearSpy.mockClear(); fitSpy.mockClear(); });

import { Terminal } from '../../../components/terminal/Terminal';

const CLEAR = '\x1b[H\x1b[2J';

describe('Terminal', () => {
  it('mounts xterm and writes pane frames atomically (no separate clear)', () => {
    render(<Terminal name="orca-A" />);
    expect(openSpy).toHaveBeenCalled();
    act(() => FakeES.last.emit('pane', { pane: 'frame-1' }));
    expect(clearSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(`${CLEAR}frame-1`);
  });

  it('skips write when pane is unchanged (B1 — idle dedupe guard)', () => {
    render(<Terminal name="orca-B" />);
    // paneRef starts as '' and pane starts as '' — identical, so no write
    act(() => FakeES.last.emit('pane', { pane: '' }));
    expect(clearSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('ResizeObserver is attached on mount (B2)', () => {
    // ResizeObserver stub is in tests/setup.ts; verify observe was called on the container
    const observeSpy = vi.spyOn(globalThis.ResizeObserver.prototype, 'observe');
    render(<Terminal name="orca-C" />);
    expect(observeSpy).toHaveBeenCalled();
    observeSpy.mockRestore();
  });
});
