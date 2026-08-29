import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { HelpTip } from '../../../components/ui/HelpTip';

const stubRect = (el: Element, rect: Partial<DOMRect>) => {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }),
  });
};

describe('HelpTip', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('portals a tooltip to the right of its trigger when there is no room on the left', () => {
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    stubRect(trigger, { top: 24, bottom: 40, left: 12, right: 28, width: 16, height: 16 });

    fireEvent.click(trigger);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.parentElement).toBe(document.body);
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    expect(trigger).toHaveClass('pointer-coarse:h-[var(--touch-target)]', 'pointer-coarse:w-[var(--touch-target)]');
    expect(tooltip.style.left).toBe('36px');
  });

  it('flips the tooltip above the trigger when its body would overflow the bottom of the viewport', () => {
    // jsdom's viewport is 768px tall; a real 120px body just above the fold would spill past it.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    stubRect(trigger, { top: 700, bottom: 716, left: 300, right: 316, width: 16, height: 16 });

    fireEvent.click(trigger);

    const tooltip = screen.getByRole('tooltip');
    const top = Number.parseInt(tooltip.style.top, 10);
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    // Opened above the trigger, and the whole body clears the bottom edge — no pixel constants, just
    // the invariants that make it usable near the fold.
    expect(top).toBeLessThanOrEqual(700);
    expect(top + 120).toBeLessThanOrEqual(viewportHeight);
    expect(top).toBeGreaterThanOrEqual(12);
  });

  it('opens below the trigger when there is room beneath it', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    stubRect(trigger, { top: 24, bottom: 40, left: 300, right: 316, width: 16, height: 16 });

    fireEvent.click(trigger);

    const top = Number.parseInt(screen.getByRole('tooltip').style.top, 10);
    // Below the trigger's bottom edge, not flipped.
    expect(top).toBeGreaterThanOrEqual(40);
  });

  it('never intercepts a click meant for the control it floats over', () => {
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    stubRect(trigger, { top: 24, bottom: 40, left: 300, right: 316, width: 16, height: 16 });

    fireEvent.mouseEnter(trigger.parentElement!);

    // The body is 256px of help text hanging over neighbouring fields, and it holds nothing worth
    // clicking — so it must be transparent to the pointer, or it swallows clicks aimed at those fields.
    // jsdom cannot hit-test, and this class IS the mechanism, so assert it directly.
    expect(screen.getByRole('tooltip')).toHaveClass('pointer-events-none');
  });

  it('closes shortly after leaving the body when the pointer does not return', () => {
    vi.useFakeTimers();
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    const wrapper = trigger.parentElement!;
    stubRect(trigger, { top: 24, bottom: 40, left: 300, right: 316, width: 16, height: 16 });

    fireEvent.mouseEnter(wrapper);
    fireEvent.mouseLeave(wrapper);
    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on focus and closes on blur after the debounce', () => {
    vi.useFakeTimers();
    render(<LanguageProvider><HelpTip>Helpful context</HelpTip></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'Help' });
    stubRect(trigger, { top: 24, bottom: 40, left: 300, right: 316, width: 16, height: 16 });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.blur(trigger);
    // Still open during the close debounce…
    expect(screen.queryByRole('tooltip')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    // …then gone.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
