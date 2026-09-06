import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Toggle } from '../../../components/ui/Toggle';

function pressSpace(control: HTMLElement): void {
  fireEvent.keyDown(control, { key: ' ', code: 'Space' });
  fireEvent.keyUp(control, { key: ' ', code: 'Space' });
  // jsdom does not perform the native button activation that browsers dispatch after Space.
  fireEvent.click(control);
}

describe('Toggle', () => {
  it('reflects checked and fires onChange', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Sonnet" />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('disabled blocks onChange', () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toggles with Space and click', async () => {
    const onChange = vi.fn();
    function ControlledToggle() {
      const [checked, setChecked] = useState(false);
      return (
        <Toggle
          checked={checked}
          onChange={(next) => {
            onChange(next);
            setChecked(next);
          }}
          label="Notifications"
        />
      );
    }

    render(<ControlledToggle />);
    const sw = screen.getByRole('switch', { name: 'Notifications' });
    sw.focus();
    pressSpace(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(onChange).toHaveBeenNthCalledWith(1, true);

    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });
});

/** Geometry PINS, measured off the reference dashboard. A number here changing is a design decision. */
describe('Switch geometry', () => {
  const thumbOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="switch-thumb"]')!;

  it('fills the track with the thumb: 36×18 track, 18px thumb, 18px of travel', () => {
    const { container } = render(<Toggle checked={false} onChange={vi.fn()} label="Sonnet" />);
    const track = screen.getByRole('switch');
    expect(track.className).toContain('h-[18px]');
    expect(track.className).toContain('w-9');
    // A thumb the full height of the track reads as the track's own moving half. The old 14px one, inset
    // inside a 1px border, read as a dot rattling around in a slot.
    expect(thumbOf(container).className).toContain('size-[18px]');
    expect(thumbOf(container).className).toContain('data-[state=checked]:translate-x-[18px]');
  });

  it('carries no border, so the thumb CAN be the full track height', () => {
    const track = render(<Toggle checked={false} onChange={vi.fn()} label="Sonnet" />).container
      .querySelector<HTMLElement>('[data-slot="switch"]')!;
    expect(track.className).not.toContain('border-border');
    expect(track.className).not.toMatch(/(^|\s)border(\s|$)/);
    // Losing the border took a focus edge with it, so the ring moves outside the track instead.
    expect(track.className).toContain('focus-visible:ring-offset-2');
  });

  it('moves the fill and the thumb on ONE clock, and never on a spring', () => {
    const { container } = render(<Toggle checked onChange={vi.fn()} label="Sonnet" />);
    const track = container.querySelector<HTMLElement>('[data-slot="switch"]')!;
    // Both halves of one movement. They used to run on different durations, so the colour arrived at the
    // new state while the thumb was still halfway across.
    for (const part of [track, thumbOf(container)]) {
      expect(part.style.transitionDuration).toBe('var(--motion-base)');
      // A token, not a literal: `data-effects='off'` and prefers-reduced-motion zero the token, and a
      // hard-coded 150ms would keep animating straight through both.
      expect(part.style.transitionTimingFunction).toBe('var(--ease-standard)');
      expect(part.style.transitionTimingFunction).not.toContain('spring');
    }
  });

  it('keeps the neutral OFF track and the primary ON track', () => {
    const track = render(<Toggle checked={false} onChange={vi.fn()} label="Sonnet" />).container
      .querySelector<HTMLElement>('[data-slot="switch"]')!;
    expect(track.className).toContain('data-[state=unchecked]:bg-secondary');
    expect(track.className).toContain('data-[state=checked]:bg-primary');
  });
});
