import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { HelpTip } from '../../../components/ui/HelpTip';

const renderTip = (align?: 'left' | 'right') => render(
  <LanguageProvider><HelpTip align={align}>Helpful context</HelpTip></LanguageProvider>,
);

describe('HelpTip', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('opens on tap and describes its trigger with a tooltip rendered in place', async () => {
    const { container } = renderTip();
    const trigger = screen.getByRole('button', { name: 'Help' });

    // A phone has no hover, so the press IS the affordance — this is why the parts underneath sit on
    // Radix's Popover rather than its Tooltip, whose trigger dismisses on press.
    fireEvent.click(trigger);

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Helpful context');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
    // The hint DESCRIBES the control; it is not a dialog the reader navigates into, so the button must
    // not claim a popup either.
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    // Rendered where it was written, NOT portaled to <body>: a hint belonging to a field inside a
    // dialog would otherwise land outside it and be marked inert by the next overlay to open.
    expect(container).toContainElement(tip);
    // A finger needs a target it can hit, even though the glyph is 16px.
    expect(trigger).toHaveClass('pointer-coarse:h-[var(--touch-target)]', 'pointer-coarse:w-[var(--touch-target)]');
  });

  it('never intercepts a click meant for the control it floats over', async () => {
    renderTip();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Help' }));

    // The body is 256px of help text hanging over neighbouring fields, and it holds nothing worth
    // clicking — so it must be transparent to the pointer, or it swallows clicks aimed at those fields.
    // jsdom cannot hit-test, and this class IS the mechanism, so assert it directly.
    expect(await screen.findByRole('tooltip')).toHaveClass('pointer-events-none');
  });

  it('asks for a placement that stays on screen: below the trigger, hanging the way `align` says', async () => {
    // The geometry is Radix's now — `side`, `align` and `collisionPadding` replace the hand-measured
    // flipping this component used to carry — so what is worth pinning is the request, which is what
    // decides where a hint at the edge of the viewport ends up.
    const { unmount } = renderTip();
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const rightAligned = await screen.findByRole('tooltip');
    expect(rightAligned).toHaveAttribute('data-side', 'bottom');
    expect(rightAligned).toHaveAttribute('data-align', 'end');
    unmount();

    renderTip('left');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(await screen.findByRole('tooltip')).toHaveAttribute('data-align', 'start');
  });

  it('closes shortly after leaving the trigger when the pointer does not return', async () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: 'Help' });

    fireEvent.mouseEnter(trigger);
    await screen.findByRole('tooltip');
    fireEvent.mouseLeave(trigger);

    // Still open during the close debounce, so a pointer clipping the gutter doesn't make it flicker.
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('opens on focus and closes on blur after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTip();
    const trigger = screen.getByRole('button', { name: 'Help' });

    fireEvent.focus(trigger);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape and leaves focus on the trigger', async () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: 'Help' });
    // Focusing the trigger opens the tip by itself — that is the keyboard route to the same body.
    await act(async () => { trigger.focus(); });
    await screen.findByRole('tooltip');

    // Radix dismisses from a document-level listener, so the state update lands outside the event's
    // own tick — the assertion has to await it rather than read the DOM straight after the keypress.
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Escape' }); });

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    // The tip never takes focus, so dismissing it must not move it either.
    expect(trigger).toHaveFocus();
  });
});
