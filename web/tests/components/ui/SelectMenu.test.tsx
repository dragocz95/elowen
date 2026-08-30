import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectMenu } from '../../../components/ui/SelectMenu';

const options = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' },
  { value: 'three', label: 'Three' },
];

/** Radix moves focus inside the open listbox a frame after the keystroke, so every assertion about the
 *  highlighted option has to be awaited. It must be awaited on the EXPECTED label, too: waiting merely
 *  for "some option has focus" is satisfied by the option that was already focused, so the assertion
 *  passes before the key has been acted on and the test proves nothing. */
const expectFocusedOption = (label: string) => waitFor(() => {
  const active = document.activeElement;
  expect(active?.getAttribute('role')).toBe('option');
  expect(active).toHaveTextContent(label);
});

describe('SelectMenu', () => {
  it('supports arrow, End, typeahead and Enter selection, and returns focus to the trigger', async () => {
    const onChange = vi.fn();
    render(<SelectMenu value="one" onChange={onChange} options={options} label="Choice" />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await expectFocusedOption('One');

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await expectFocusedOption('Three');

    // Typeahead skips the option it starts from, so a single 't' from "Three" lands on "Two".
    fireEvent.keyDown(document.activeElement!, { key: 't' });
    await expectFocusedOption('Two');

    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('two');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape without choosing', async () => {
    const onChange = vi.fn();
    render(<SelectMenu value="one" onChange={onChange} options={options} label="Choice" />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await expectFocusedOption('One');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  // Two call sites offer an empty-valued option as a REAL choice rather than an empty state: "no
  // category" in the memory modals and the preset placeholder in the terminal settings. Older Radix
  // reserved '' for "nothing selected" and refused it on an item, which would have forced a sentinel
  // through the public API; the installed version accepts it and marks the option checked, so no
  // translation layer exists. This pins that, because the day it stops being true both call sites break
  // and neither of them says why.
  it('keeps an empty-string option selectable and reports it back unchanged', async () => {
    const onChange = vi.fn();
    const withEmpty = [{ value: '', label: 'None' }, ...options];
    render(<SelectMenu value="two" onChange={onChange} options={withEmpty} label="Choice" />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });
    expect(trigger).toHaveTextContent('Two');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await expectFocusedOption('Two');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await expectFocusedOption('None');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows the selected option on the trigger', () => {
    render(<SelectMenu value="three" onChange={vi.fn()} options={options} label="Choice" />);
    expect(screen.getByRole('combobox', { name: 'Choice' })).toHaveTextContent('Three');
  });

  /** The caller's class sizes the CONTROL, not the trigger. The trigger is `w-full` by shadcn's shape —
   *  which is right, it should fill whatever box it is given — so a caller's class landing on it makes
   *  the trigger itself the sized box. Dropped into a flex toolbar that claims the whole line and folds
   *  every sibling filter onto a row of its own, which is exactly what happened to the memory page. */
  it('puts the caller class on a wrapper, so the full-width trigger fills it instead of the toolbar', () => {
    render(<SelectMenu value="one" onChange={vi.fn()} options={options} label="Choice" className="min-w-[9.5rem]" />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });
    expect(trigger).not.toHaveClass('min-w-[9.5rem]');
    expect(trigger.parentElement).toHaveClass('min-w-[9.5rem]');
  });

  /** `disabled` was accepted by callers and dropped on the floor: the msteams account picker passes it
   *  while its link mutation is in flight, and the control stayed openable throughout that save. The
   *  prop is part of the published plugin ABI, so a bundle passing it has to actually lock the trigger. */
  it('locks the trigger while disabled, and does not open on a keystroke', () => {
    const onChange = vi.fn();
    render(<SelectMenu value="one" onChange={onChange} options={options} label="Choice" disabled />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });

    expect(trigger).toBeDisabled();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  /** A rejected value has to read the same on a select as on a text field, which marks itself with
   *  `aria-invalid` and is styled off that attribute rather than off a bespoke class. */
  it('marks a rejected value with aria-invalid, and leaves a good one unmarked', () => {
    const { rerender } = render(<SelectMenu value="one" onChange={vi.fn()} options={options} label="Choice" />);
    expect(screen.getByRole('combobox', { name: 'Choice' })).not.toHaveAttribute('aria-invalid');

    rerender(<SelectMenu value="one" onChange={vi.fn()} options={options} label="Choice" invalid />);
    expect(screen.getByRole('combobox', { name: 'Choice' })).toHaveAttribute('aria-invalid', 'true');
  });
});
