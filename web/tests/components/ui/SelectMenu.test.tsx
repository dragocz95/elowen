import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectMenu } from '../../../components/ui/SelectMenu';

const options = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' },
  { value: 'three', label: 'Three' },
];

describe('SelectMenu', () => {
  it('supports arrow, Home, End, Enter and typeahead selection', () => {
    const onChange = vi.fn();
    render(<SelectMenu value="one" onChange={onChange} options={options} label="Choice" />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'One' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('option', { name: 'One' }), { key: 'End' });
    expect(screen.getByRole('option', { name: 'Three' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('option', { name: 'Three' }), { key: 't' });
    expect(screen.getByRole('option', { name: 'Two' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('option', { name: 'Two' }), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('two');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
