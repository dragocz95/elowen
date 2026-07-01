import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';

const writeSpy = vi.fn();
let onDataHandler: ((d: string) => void) | null = null;
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open = vi.fn(); write = writeSpy; clear = vi.fn(); dispose = vi.fn(); loadAddon = vi.fn(); cols = 80; rows = 24; options: { theme?: unknown } = {}; onData = (fn: (d: string) => void) => { onDataHandler = fn; return { dispose: vi.fn() }; }; },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const sendSpy = vi.fn();
const resizeSpy = vi.fn();
let status = 'open';
let capturedOnData: ((b: string) => void) | null = null;
vi.mock('../../../lib/useTerminalStream', () => ({
  useTerminalStream: (_name: string, _enabled: boolean, onData: (b: string) => void) => {
    capturedOnData = onData;
    return { status, send: sendSpy, resize: resizeSpy };
  },
}));
vi.mock('../../../components/terminal/Terminal', () => ({
  Terminal: ({ name, interactive }: { name: string; interactive?: boolean }) => <div data-testid="snapshot-fallback">{name}:{String(interactive)}</div>,
}));

beforeEach(() => { writeSpy.mockClear(); sendSpy.mockClear(); resizeSpy.mockClear(); onDataHandler = null; capturedOnData = null; status = 'open'; });

import { StreamTerminal } from '../../../components/terminal/StreamTerminal';
import { createWrapper } from '../../test-utils';

describe('StreamTerminal', () => {
  it('writes inbound stream bytes into xterm', () => {
    render(<StreamTerminal name="orca-advisor-1" />, { wrapper: createWrapper().wrapper });
    act(() => capturedOnData!('\x1b[32mhi'));
    expect(writeSpy).toHaveBeenCalledWith('\x1b[32mhi');
  });

  it('forwards keystrokes to the stream', () => {
    render(<StreamTerminal name="orca-advisor-1" />, { wrapper: createWrapper().wrapper });
    expect(onDataHandler).not.toBeNull();
    act(() => onDataHandler!('x'));
    expect(sendSpy).toHaveBeenCalledWith('x');
  });

  it('pushes the terminal size to the stream once the socket is open', () => {
    render(<StreamTerminal name="orca-advisor-1" />, { wrapper: createWrapper().wrapper });
    // status is 'open' → the size must be synced (cols/rows from the xterm mock).
    expect(resizeSpy).toHaveBeenCalledWith(80, 24);
  });

  it('renders the interactive snapshot fallback when the stream is unsupported', () => {
    status = 'unsupported';
    render(<StreamTerminal name="orca-worker1" />, { wrapper: createWrapper().wrapper });
    const fb = screen.getByTestId('snapshot-fallback');
    expect(fb.textContent).toBe('orca-worker1:true'); // fallback is interactive
  });
});
