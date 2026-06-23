import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from '../../../components/ui/ResizeHandle';

describe('ResizeHandle', () => {
  it('emits the pointer delta along the drag axis (vertical → dx)', () => {
    const onDelta = vi.fn();
    const onEnd = vi.fn();
    render(<ResizeHandle orientation="vertical" onDelta={onDelta} onEnd={onEnd} />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 0, pointerId: 1 });
    expect(onDelta).toHaveBeenCalledWith(30);
    fireEvent.pointerUp(handle, { clientX: 130, clientY: 0, pointerId: 1 });
    expect(onEnd).toHaveBeenCalled();
  });

  it('emits dy for a horizontal handle and ignores moves before a pointerDown', () => {
    const onDelta = vi.fn();
    render(<ResizeHandle orientation="horizontal" onDelta={onDelta} />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 50, pointerId: 1 }); // not dragging yet
    expect(onDelta).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 70, pointerId: 1 });
    expect(onDelta).toHaveBeenCalledWith(20);
  });
});
