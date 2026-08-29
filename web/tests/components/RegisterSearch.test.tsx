import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegisterSearch } from '../../components/ui/RegisterSearch';

describe('RegisterSearch', () => {
  it('reports every keystroke and names the field after its placeholder', () => {
    const onChange = vi.fn();
    render(<RegisterSearch value="" onChange={onChange} placeholder="Search memories" />);
    const input = screen.getByRole('searchbox', { name: 'Search memories' });
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(onChange).toHaveBeenCalledWith('ab');
  });

  it('prefers an explicit label over the placeholder', () => {
    render(<RegisterSearch value="" onChange={vi.fn()} placeholder="Search…" label="Search assets" />);
    expect(screen.getByRole('searchbox', { name: 'Search assets' })).toBeInTheDocument();
  });

  // A 240px minimum width was exactly what pushed the sibling filters out of the toolbar at 320px.
  it('shrinks with the toolbar instead of claiming a minimum width', () => {
    const { container } = render(<RegisterSearch value="" onChange={vi.fn()} placeholder="Search" />);
    const field = container.firstElementChild!;
    expect(field).toHaveClass('min-w-0');
    expect(field).toHaveClass('flex-1');
    expect(field.className).not.toMatch(/min-w-\[/);
  });

  it('shows the clear button only once there is something to clear', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <RegisterSearch value="" onChange={vi.fn()} onClear={onClear} clearLabel="Clear search" />,
    );
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    rerender(<RegisterSearch value="db" onChange={vi.fn()} onClear={onClear} clearLabel="Clear search" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('omits the clear button when no accessible name was given for it', () => {
    render(<RegisterSearch value="db" onChange={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the match count with a spoken label beside the bare number', () => {
    render(<RegisterSearch value="db" onChange={vi.fn()} count={12} countLabel="12 results" />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('12 results');
  });
});
