import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Slider } from '../../../components/ui/Slider';

describe('Slider', () => {
  it('moves with ArrowRight and ArrowLeft and reports scalar values', async () => {
    const onChange = vi.fn();
    function ControlledSlider() {
      const [value, setValue] = useState(5);
      return (
        <Slider
          value={value}
          min={0}
          max={10}
          step={1}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          aria-label="Volume"
        />
      );
    }

    render(<ControlledSlider />);
    const slider = screen.getByRole('slider', { name: 'Volume' });
    slider.focus();

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('6'));
    expect(onChange).toHaveBeenNthCalledWith(1, 6);

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('5'));
    expect(onChange).toHaveBeenNthCalledWith(2, 5);
  });
});
