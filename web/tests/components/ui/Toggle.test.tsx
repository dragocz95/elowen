import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    // …and it states no focus utilities either. base.css gives [role="switch"]:focus-visible a ring and
    // is imported unlayered, so it outranks Tailwind's utilities layer — a focus-visible:ring-* class
    // here would paint nothing while reading as if it did.
    expect(track.className).not.toContain('focus-visible:ring');
  });

  it('draws the OFF track with a token that is not one of the surfaces it sits on', () => {
    // The fill is the ONLY thing drawing the control now. `secondary` aliases --color-muted, a SURFACE:
    // studio-oled resolves it to #080d0f, byte-identical to that skin's card, so an OFF switch on a card
    // was a thumb floating on nothing.
    const track = render(<Toggle checked={false} onChange={vi.fn()} label="Sonnet" />).container
      .querySelector<HTMLElement>('[data-slot="switch"]')!;
    expect(track.className).toContain('data-[state=unchecked]:bg-border');
    expect(track.className).not.toContain('bg-secondary');
  });

  it('keeps the OFF track token from collapsing into a surface in a future palette', () => {
    // A GUARD, not a proof of the fix above — it reads the skins, which the switch change did not touch,
    // so it would pass on either side of it. What it defends is the property that made `secondary`
    // unusable here: a token that resolves to the same value as the surface it is drawn on leaves the
    // track with no extent. `--color-border` satisfies that today in both designs, and a palette edit
    // that quietly stopped satisfying it would otherwise be invisible until someone looked at a toggle.
    //
    // Equality, not a contrast ratio: the ratios here are legitimately faint (about 1.14:1 on card) and
    // the thumb is what carries perceivability, so a threshold would either fail honest palettes or
    // assert nothing. `--color-sticky` is out of reach either way, being color-mix()-derived in
    // tokens.css rather than stated in a skin.
    const read = (path: string) => readFileSync(join(resolve(process.cwd()), path), 'utf-8');
    const valueOf = (css: string, token: string) => css.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();
    for (const skin of ['studio-light', 'studio-oled']) {
      const css = read(`skins/${skin}/skin.css`);
      const track = valueOf(css, '--color-border');
      expect(track, `${skin} states no --color-border`).toBeDefined();
      for (const surface of ['--color-card', '--color-muted', '--color-background']) {
        expect(track, `${skin}: the OFF track is the same colour as ${surface}`).not.toBe(valueOf(css, surface));
      }
    }
  });

  it('moves the fill and the thumb on ONE clock, and never on a spring', () => {
    const { container } = render(<Toggle checked onChange={vi.fn()} label="Sonnet" />);
    const track = container.querySelector<HTMLElement>('[data-slot="switch"]')!;
    // Both halves of one movement. They used to run on different durations, so the colour arrived at the
    // new state while the thumb was still halfway across.
    for (const part of [track, thumbOf(container)]) {
      // A token, not a literal: `data-effects='off'` sets --motion-base to 0ms, and a hard-coded 150ms
      // would keep animating straight through it.
      expect(part.style.transitionDuration).toBe('var(--motion-base)');
      // A spring overshoots, and a thumb that fills its track has nowhere to overshoot to.
      expect(part.style.transitionTimingFunction).toBe('var(--ease-standard)');
      expect(part.style.transitionTimingFunction).not.toContain('spring');
    }
  });

  it('paints the ON track with the brand fill', () => {
    const track = render(<Toggle checked onChange={vi.fn()} label="Sonnet" />).container
      .querySelector<HTMLElement>('[data-slot="switch"]')!;
    expect(track.className).toContain('data-[state=checked]:bg-primary');
  });
});
