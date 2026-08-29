import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Checkbox } from '../../../components/ui/shadcn/checkbox';

function pressSpace(control: HTMLElement): void {
  fireEvent.keyDown(control, { key: ' ', code: 'Space' });
  fireEvent.keyUp(control, { key: ' ', code: 'Space' });
  // jsdom does not perform the native button activation that browsers dispatch after Space.
  fireEvent.click(control);
}

describe('Checkbox', () => {
  it('toggles with Space and click and reports checked changes', async () => {
    const onCheckedChange = vi.fn();
    function ControlledCheckbox() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => {
            onCheckedChange(next);
            if (typeof next === 'boolean') setChecked(next);
          }}
          aria-label="Select row"
        />
      );
    }

    render(<ControlledCheckbox />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select row' });
    checkbox.focus();
    pressSpace(checkbox);
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'));
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, true);

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('false'));
    expect(onCheckedChange).toHaveBeenNthCalledWith(2, false);
  });

  // Radix renders the indicator for `indeterminate` as well as for `checked`, so a "some of these rows"
  // header checkbox drew the same tick as a fully selected one: `aria-checked="mixed"` told a screen
  // reader the truth while the pixels told everyone else the opposite.
  it('marks a partial selection with a dash rather than the tick that means "all"', () => {
    const { container } = render(<Checkbox checked="indeterminate" aria-label="Select all rows" />);

    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute('aria-checked', 'mixed');
    const glyph = container.querySelector('[data-slot="checkbox-indicator"] svg');
    expect(glyph?.getAttribute('class')).toContain('lucide-minus');
    expect(glyph?.getAttribute('class')).not.toContain('lucide-check');
  });

  it('still marks a full selection with the tick', () => {
    // The other half of the same pair: a dash for every state would be the identical defect inverted.
    const { container } = render(<Checkbox checked aria-label="Select all rows" />);

    const glyph = container.querySelector('[data-slot="checkbox-indicator"] svg');
    expect(glyph?.getAttribute('class')).toContain('lucide-check');
    expect(glyph?.getAttribute('class')).not.toContain('lucide-minus');
  });
});
