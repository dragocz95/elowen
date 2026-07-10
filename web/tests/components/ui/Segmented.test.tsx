import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  it('uses roving focus and arrow keys for the radio group', () => {
    const onChange = vi.fn();
    render(<Segmented aria-label="Mode" options={opts} value="b" onChange={onChange} />);
    const active = screen.getByRole('radio', { name: 'B' });
    expect(active).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    active.focus();
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.getByRole('radio', { name: 'C' })).toHaveFocus();
  });
});
