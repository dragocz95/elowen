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
});
