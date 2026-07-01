import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const writeSpy = vi.fn(); const clearSpy = vi.fn(); const openSpy = vi.fn(); const disposeSpy = vi.fn();
const fitSpy = vi.fn();
let onDataHandler: ((data: string) => void) | null = null;
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open = openSpy; write = writeSpy; clear = clearSpy; dispose = disposeSpy; loadAddon = vi.fn(); options: { theme?: unknown } = {}; onData = (fn: (d: string) => void) => { onDataHandler = fn; return { dispose: vi.fn() }; }; },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = fitSpy; } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const sessionInputSpy = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true }));
vi.mock('../../../lib/orcaClient', () => ({ BASE: '/api', orcaClient: { resizeSession: vi.fn(() => Promise.resolve({ ok: true })), sessionInput: (name: string, data: string) => sessionInputSpy(name, data) } }));

class FakeES { static last: FakeES; listeners: Record<string, (e: { data: string }) => void> = {}; close() {} constructor(public url: string) { FakeES.last = this; } addEventListener(t: string, fn: (e: { data: string }) => void) { this.listeners[t] = fn; } emit(t: string, d: unknown) { this.listeners[t]?.({ data: JSON.stringify(d) }); } }
beforeEach(() => { (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES; writeSpy.mockClear(); clearSpy.mockClear(); fitSpy.mockClear(); sessionInputSpy.mockClear(); onDataHandler = null; });

import { Terminal } from '../../../components/terminal/Terminal';
import { createWrapper } from '../../test-utils';

const CLEAR = '\x1b[H\x1b[2J';
const HIDE = '\x1b[?25l';

describe('Terminal', () => {
  it('mounts xterm and writes pane frames atomically (no separate clear)', () => {
    render(<Terminal name="orca-A" />, { wrapper: createWrapper().wrapper });
    expect(openSpy).toHaveBeenCalled();
    act(() => FakeES.last.emit('pane', { pane: 'frame-1' }));
    expect(clearSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(`${CLEAR}frame-1${HIDE}`);
  });

  it('skips write when pane is unchanged (B1 — idle dedupe guard)', () => {
    render(<Terminal name="orca-B" />, { wrapper: createWrapper().wrapper });
    // paneRef starts as '' and pane starts as '' — identical, so no write
    act(() => FakeES.last.emit('pane', { pane: '' }));
    expect(clearSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('non-interactive terminal does not wire keyboard input', () => {
    render(<Terminal name="orca-D" />, { wrapper: createWrapper().wrapper });
    expect(onDataHandler).toBeNull(); // read-only: no onData subscription
  });

  it('interactive terminal forwards every keystroke verbatim to the input endpoint', () => {
    render(<Terminal name="orca-E" interactive />, { wrapper: createWrapper().wrapper });
    expect(onDataHandler).not.toBeNull();
    act(() => onDataHandler!('\x1b[A')); // up-arrow bytes
    act(() => onDataHandler!('x'));
    expect(sessionInputSpy).toHaveBeenCalledWith('orca-E', '\x1b[A');
    expect(sessionInputSpy).toHaveBeenCalledWith('orca-E', 'x');
  });

  it('ResizeObserver is attached on mount (B2)', () => {
    // ResizeObserver stub is in tests/setup.ts; verify observe was called on the container
    const observeSpy = vi.spyOn(globalThis.ResizeObserver.prototype, 'observe');
    render(<Terminal name="orca-C" />, { wrapper: createWrapper().wrapper });
    expect(observeSpy).toHaveBeenCalled();
    observeSpy.mockRestore();
  });
});
