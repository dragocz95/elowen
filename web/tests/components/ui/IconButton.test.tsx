import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { X } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';

describe('IconButton', () => {
  it('renders with aria-label and fires onClick', () => {
    const onClick = vi.fn();
    render(<IconButton icon={X} label="Close" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });
  it('disabled blocks onClick', () => {
    const onClick = vi.fn();
    render(<IconButton icon={X} label="Close" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  /** The 28px square is the whole reason this component exists, and it now arrives through two layers —
   *  the `icon` size for the square box, this file's `className` for the scale and the corners. A merge
   *  that stopped resolving the conflict would leave `size-9` in place and the control would silently
   *  grow back to 36px, setting the height of every table row it sits in. */
  it('is a 28px square, with the primitive size it overrides actually gone', () => {
    render(<IconButton icon={X} label="Close" />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.className).toContain('size-7');
    expect(button.className).not.toContain('size-9');
    // From the `icon` size, not from this file: without it the wrapper's default padding survives and the
    // square is 28px tall and wider than it is high.
    expect(button.className).toContain('p-0');
    expect(button.className).not.toContain('px-3.5');
    expect(button.className).toContain('rounded-none');
    expect(button.className).not.toContain('rounded-md');
  });

  /** Both variants map through the app wrapper's vocabulary — `default` here is the OUTLINE button, not
   *  the app's `default` fill. Pinning the painted classes is what catches the map being rewired. */
  it('paints default as the outline button and danger as the destructive outline', () => {
    render(<IconButton icon={X} label="Edit" />);
    render(<IconButton icon={X} label="Delete" variant="danger" />);

    const plain = screen.getByRole('button', { name: 'Edit' }).className;
    expect(plain).toContain('border-border');
    expect(plain).toContain('bg-transparent');
    expect(plain).not.toContain('bg-secondary');

    const danger = screen.getByRole('button', { name: 'Delete' }).className;
    expect(danger).toContain('border-destructive');
    expect(danger).toContain('text-destructive');
    expect(danger).toContain('bg-transparent');
  });
});
