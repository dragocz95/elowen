import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { RecapStrip } from '../../../modules/dashboard/RecapStrip';
import { createWrapper } from '../../test-utils';
import { consumePendingBrainComposer, consumePendingBrainSession } from '../../../lib/brainDock';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { DashRecap, DashRecapVariant } from '../../../lib/types';

const READY: DashRecap = {
  enabled: true,
  continue: [
    { id: 's-1', title: 'Dashboard redesign', updatedAt: '2026-08-30 22:41:00' },
    { id: 's-2', title: 'Teams reactions', updatedAt: '2026-08-30 18:03:00' },
  ],
  yesterday: { turns: 14, tokens: 1_200_000, sessions: ['Dashboard redesign', 'Teams reactions'] },
  digest: {
    status: 'ready',
    summary: 'You mostly worked on the **dashboard redesign**.',
    suggestions: [{ label: 'Finish price tests', prompt: 'Finish the price regression tests' }],
  },
};

function draw(recap: DashRecap | undefined) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><RecapStrip recap={recap} /></Wrapper>);
}

describe('RecapStrip', () => {
  it('renders nothing without data, when disabled, and when there is nothing to say', () => {
    expect(draw(undefined).container).toBeEmptyDOMElement();
    expect(draw({ enabled: false }).container).toBeEmptyDOMElement();
    expect(draw({ enabled: true, continue: [], yesterday: null, digest: { status: 'unavailable' } }).container).toBeEmptyDOMElement();
  });

  it('shows the digest sentence with its emphasis, continue pills and suggestion pills', () => {
    draw(READY);
    // The **bold** marker renders as emphasis, never as literal asterisks.
    expect(screen.getByText('dashboard redesign')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.getByRole('button', { name: /Dashboard redesign/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finish price tests/ })).toBeInTheDocument();
  });

  it('falls back to the deterministic yesterday sentence while the digest is generating', () => {
    draw({ ...READY, digest: { status: 'generating' } });
    expect(screen.getByText(
      en.dashboard.recap.fallback.replace('{sessions}', 'Dashboard redesign, Teams reactions'),
    )).toBeInTheDocument();
  });

  it('a continue pill opens the stored conversation; a suggestion pill seeds the composer', () => {
    draw(READY);
    fireEvent.click(screen.getByRole('button', { name: /Teams reactions/ }));
    expect(consumePendingBrainSession()).toEqual({ sessionId: 's-2', continuable: true });
    fireEvent.click(screen.getByRole('button', { name: /Finish price tests/ }));
    expect(consumePendingBrainComposer()).toBe('Finish the price regression tests');
  });
});

const variant = (n: number): DashRecapVariant => ({
  summary: `Telling number ${n} of the day.`,
  suggestions: [{ label: `Step ${n}`, prompt: `Do step ${n}` }],
});
const BATCH: DashRecap = {
  enabled: true,
  yesterday: { turns: 14, tokens: 1_200_000, sessions: ['Dashboard redesign'] },
  digest: {
    status: 'ready',
    summary: variant(1).summary,
    suggestions: variant(1).suggestions,
    recaps: [variant(1), variant(2), variant(3)],
  },
};

describe('RecapStrip rotation', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a single (or legacy, recaps-less) digest renders as one variant with no rotation controls', () => {
    draw(READY);
    expect(screen.getByText(/You mostly worked on the/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: en.dashboard.recap.rotation })).toBeNull();
    expect(screen.queryByText(/\/ 1/)).toBeNull();
  });

  it('starts on variant 1 (SSR-stable), shows quiet controls and never announces the rotation', () => {
    const { container } = draw(BATCH);
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: en.dashboard.recap.rotation });
    // The swap is silence on purpose: a live region would read one variant after another out loud.
    expect(group.parentElement?.querySelector('[aria-live="off"]')).not.toBeNull();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]')).not.toHaveLength(0);
    // The WHOLE batch is parked in the same grid cell from the first paint, so the strip reserves the
    // tallest variant's height and nothing below it jumps when a longer variant fades out.
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    expect(screen.getByText('Telling number 3 of the day.')).toBeInTheDocument();
    // The first paint is NOT animated: the server-rendered frame is visible immediately, no fade-in.
    const firstLayer = screen.getByText('Telling number 1 of the day.').closest('[class*="grid-area"]');
    expect(firstLayer).not.toHaveClass('recap-variant-in');
  });

  it('advances by itself every 12 seconds and cleans its timers on unmount', () => {
    vi.useFakeTimers();
    const { unmount, container } = draw(BATCH);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    // The outgoing variant stays mounted for the crossfade, but inert: unfocusable, unannounced.
    const leaving = screen.getByText('Telling number 1 of the day.').closest('[class*="recap-variant-out"]');
    expect(leaving).not.toBeNull();
    expect(leaving).toHaveAttribute('inert');
    act(() => { vi.advanceTimersByTime(700); });
    // The fade is over, but variant 1's PARKED layer remains (hidden, inert) so the box keeps the
    // batch's full height instead of collapsing down to the current variant's.
    expect(container.querySelector('.recap-variant-out')).toBeNull();
    const parked = screen.getByText('Telling number 1 of the day.').closest('[class*="grid-area"]');
    expect(parked).toHaveClass('invisible');
    expect(parked).toHaveAttribute('inert');
    expect(parked).toHaveAttribute('aria-hidden', 'true');
    // Wraps around after the last variant.
    act(() => { vi.advanceTimersByTime(12_000 * 2); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    // After unmount the interval is gone: advancing the (now orphaned) timers changes nothing anywhere.
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(60_000); })).not.toThrow();
    expect(screen.queryByText(/Telling number/)).toBeNull();
  });

  it('manual navigation works immediately, wraps both ways, and drives the keyboard too', () => {
    draw(BATCH);
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.next }));
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.prev }));
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    // Wrapping backwards from the first variant lands on the last.
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.prev }));
    expect(screen.getByText('Telling number 3 of the day.')).toBeInTheDocument();
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: en.dashboard.recap.rotation }), { key: 'ArrowRight' });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
  });

  it('the crossfade element is remounted on every switch, so the animation never gets recycled', () => {
    const { container } = draw(BATCH);
    const visibleLayer = () =>
      Array.from(container.querySelectorAll('[class*="grid-area"]')).find((n) => n.getAttribute('aria-hidden') !== 'true')!;
    const first = visibleLayer();
    expect(first).toHaveTextContent('Telling number 1 of the day.');
    expect(first).not.toHaveClass('recap-variant-in');
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.next }));
    const second = visibleLayer();
    expect(second).toHaveClass('recap-variant-in');
    expect(second).not.toBe(first); // a fresh node each switch → the CSS animation restarts
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.prev }));
    const back = visibleLayer();
    expect(back).toHaveTextContent('Telling number 1 of the day.');
    expect(back).toHaveClass('recap-variant-in');
    expect(back).not.toBe(first); // even returning to a variant remounts it: no recycled animation
  });

  it('rapid next/back during a crossfade keeps one leaving layer and one copy of every variant', () => {
    const { container } = draw(BATCH);
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.next }));
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.next }));
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getByText('Telling number 3 of the day.')).toBeInTheDocument();
    // Exactly ONE leaving layer, carrying the variant we just came from — the earlier fade is replaced.
    expect(container.querySelectorAll('.recap-variant-out')).toHaveLength(1);
    expect(container.querySelector('.recap-variant-out')).toHaveTextContent('Telling number 2 of the day.');
    // Every variant exists exactly once: visible, leaving, or parked — nothing duplicated, nothing lost.
    for (const n of [1, 2, 3]) {
      expect(screen.getAllByText(`Telling number ${n} of the day.`)).toHaveLength(1);
    }
  });

  it('hover and keyboard focus hold the rotation independently, with the blur boundary inside the strip', () => {
    vi.useFakeTimers();
    const { container } = draw(BATCH);
    const section = container.querySelector('section')!;
    const pill = screen.getByRole('button', { name: /Step 1/ });
    fireEvent.mouseEnter(section);
    fireEvent.focus(pill);
    // The pointer leaves while keyboard focus stays inside: the rotation must KEEP holding.
    fireEvent.mouseLeave(section);
    act(() => { vi.advanceTimersByTime(24_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    // Focus moving WITHIN the strip (pill → control) keeps holding too.
    const control = screen.getByRole('button', { name: en.dashboard.recap.prev });
    fireEvent.blur(pill, { relatedTarget: control });
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    // Focus leaving the strip entirely releases the hold.
    fireEvent.blur(control, { relatedTarget: null });
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
  });

  it('the pause button holds the rotation until resumed', () => {
    vi.useFakeTimers();
    draw(BATCH);
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.pause }));
    act(() => { vi.advanceTimersByTime(36_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.resume }));
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
  });

  it('hover and focus hold the rotation; leaving them lets it run again', () => {
    vi.useFakeTimers();
    const { container } = draw(BATCH);
    const section = container.querySelector('section')!;
    fireEvent.mouseEnter(section);
    act(() => { vi.advanceTimersByTime(36_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    fireEvent.mouseLeave(section);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    fireEvent.focus(section);
    act(() => { vi.advanceTimersByTime(24_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    fireEvent.blur(section);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 3 of the day.')).toBeInTheDocument();
  });

  it('a hidden tab holds the rotation', () => {
    vi.useFakeTimers();
    const { container } = draw(BATCH);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(36_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    void container;
  });

  it('reduced motion stops the automatic rotation; manual steps still work and swap instantly', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      addListener: () => {}, removeListener: () => {},
    } as unknown as MediaQueryList));
    const { container } = draw(BATCH);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Telling number 1 of the day.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.dashboard.recap.next }));
    expect(screen.getByText('Telling number 2 of the day.')).toBeInTheDocument();
    // Instant swap: no leaving layer is ever mounted, and variant 1 survives only as its parked copy.
    expect(container.querySelector('.recap-variant-out')).toBeNull();
    expect(
      screen.getAllByText('Telling number 1 of the day.')
        .every((n) => n.closest('[aria-hidden="true"]') !== null),
    ).toBe(true);
  });
});
