import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import {
  DEFAULT_TOAST_MS, MAX_TOAST_MS, MIN_TOAST_MS, ToastProvider, resolveToastDuration, useToast,
} from '../../../components/ui/Toast';

/** How long a toast holds the screen is an operator setting (Settings → Elowen AI → Runtime) the browser
 *  reads off GET /config, so the provider must actually count against the value it was handed rather than
 *  a constant — and hold an out-of-range one at its own bound, since the daemon that answered may be of
 *  another version. */
function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }
function Trigger({ tone }: { tone?: 'ok' | 'error' }) {
  const { toast } = useToast();
  return <button onClick={() => toast('Saved', tone)}>go</button>;
}

/** Auto-dismissal is Radix's close timer (a `window.setTimeout`) rather than the hand-rolled animation
 *  frame countdown this component used to run, so the test owns the clock with fake timers. The frame
 *  APIs and `performance` are faked alongside it because the progress bar still runs on rAF: left real,
 *  it would repaint outside `act()` while the timers around it are frozen. */
const useToastClock = () => vi.useFakeTimers({
  toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'],
});
const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms); }); };

afterEach(() => { vi.useRealTimers(); });

describe('toast duration — resolving the configured value', () => {
  it('takes the configured duration and holds an out-of-range one at its bound', () => {
    expect(resolveToastDuration({ toastDurationMs: 7_000 })).toBe(7_000);
    expect(resolveToastDuration({ toastDurationMs: 100 })).toBe(MIN_TOAST_MS);
    expect(resolveToastDuration({ toastDurationMs: 600_000 })).toBe(MAX_TOAST_MS);
  });

  // A zero would divide the progress bar by zero and dismiss the toast before it could be read; an absent
  // block is the ordinary case before the config query resolves.
  it('falls back to the built-in default for a missing or unusable value', () => {
    expect(resolveToastDuration(undefined)).toBe(DEFAULT_TOAST_MS);
    expect(resolveToastDuration({})).toBe(DEFAULT_TOAST_MS);
    expect(resolveToastDuration({ toastDurationMs: Number.NaN })).toBe(DEFAULT_TOAST_MS);
  });
});

describe('toast duration — the card counts against it', () => {
  it('holds the toast for the CONFIGURED duration, not the built-in default', () => {
    useToastClock();
    render(<ToastProvider durationMs={3_000}><Trigger /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    advance(2_900);
    expect(screen.getByText('Saved')).toBeInTheDocument(); // still inside the configured window
    advance(200);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('keeps the built-in default when no duration is passed', () => {
    useToastClock();
    render(<ToastProvider><Trigger /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    advance(3_100); // past the 3 s above, well inside the 4.5 s default
    expect(screen.getByText('Saved')).toBeInTheDocument();
    advance(DEFAULT_TOAST_MS - 3_100 + 100);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  /** The duration is deliberately NOT per status: an error is announced more loudly than a success but is
   *  not held any longer, and the operator sets one number for both. Pinning that here means a per-status
   *  rule has to be added on purpose rather than drift in. */
  it.each(['ok', 'error'] as const)('holds a %s toast for the same configured duration', (tone) => {
    useToastClock();
    render(<ToastProvider durationMs={3_000}><Trigger tone={tone} /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    advance(2_900);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    advance(200);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
