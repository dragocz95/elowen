import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Segmented } from '../../../components/ui/Segmented';

const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];

describe('Segmented', () => {
  it('renders a segment per option and marks the active one', () => {
    render(<Segmented options={opts} value="b" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('true');
  });
  it('fires onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(<Segmented options={opts} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'C' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });
  it('uses roving focus and arrow keys for the radio group', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('b');
      return (
        <Segmented
          aria-label="Mode"
          options={opts}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    const active = screen.getByRole('radio', { name: 'B' });
    const next = screen.getByRole('radio', { name: 'C' });
    expect(group).toHaveAttribute('tabindex', '0');
    act(() => group.focus());
    await waitFor(() => expect(active).toHaveFocus());
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    await waitFor(() => expect(next).toHaveFocus());
    expect(next).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenCalledWith('c');
  });
  it('offers a quiet underline variant for settings navigation', () => {
    render(<Segmented variant="line" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveClass('border-b');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('data-state', 'unchecked');
  });
  it('marks nowrap tabs for horizontal scrolling without a vertical overflow axis', () => {
    render(<Segmented nowrap options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('data-nowrap', 'true');
    expect(screen.getByRole('radiogroup')).toHaveClass('overflow-x-auto', 'overflow-y-hidden');
  });
  it('offers a vertical menu variant for secondary section navigation', () => {
    render(<Segmented variant="menu" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByRole('radiogroup')).toHaveClass('flex-col', 'items-stretch');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveClass('w-full');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('data-state', 'checked');
  });
});
