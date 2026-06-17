import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const writeSpy = vi.fn(); const clearSpy = vi.fn(); const openSpy = vi.fn(); const disposeSpy = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open = openSpy; write = writeSpy; clear = clearSpy; dispose = disposeSpy; loadAddon = vi.fn(); },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeES { static last: FakeES; listeners: Record<string, (e: { data: string }) => void> = {}; close() {} constructor(public url: string) { FakeES.last = this; } addEventListener(t: string, fn: any) { this.listeners[t] = fn; } emit(t: string, d: unknown) { this.listeners[t]?.({ data: JSON.stringify(d) }); } }
beforeEach(() => { (globalThis as any).EventSource = FakeES as any; });

import { Terminal } from '../../../components/terminal/Terminal';

describe('Terminal', () => {
  it('mounts xterm and writes pane frames', () => {
    render(<Terminal name="orca-A" />);
    expect(openSpy).toHaveBeenCalled();
    act(() => FakeES.last.emit('pane', { pane: 'frame-1' }));
    expect(clearSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith('frame-1');
  });
});
