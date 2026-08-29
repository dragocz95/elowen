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
