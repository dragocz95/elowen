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
  it('offers a quiet underline variant for settings navigation', () => {
    render(<Segmented variant="line" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveClass('border-b');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveClass('border-primary');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveClass('border-transparent');
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
    expect(screen.getByRole('radio', { name: 'B' })).toHaveClass('w-full', 'bg-elevated');
  });
});
