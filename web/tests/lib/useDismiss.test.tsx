import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useDismiss } from '../../lib/useDismiss';

function Overlay({ onClose, escape, startOpen = true }: { onClose: () => void; escape?: boolean; startOpen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open] = useState(startOpen);
  useDismiss(ref, open, onClose, escape === undefined ? {} : { escape });
  return (
    <div>
      <div ref={ref} data-testid="panel"><button type="button">inside</button></div>
      <button type="button" data-testid="outside">outside</button>
    </div>
  );
}

describe('useDismiss', () => {
  it('closes on a pointer press outside the panel', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a pointer press inside the panel', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape, and not on another key', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone when the overlay owns it', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} escape={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // The outside pointer still dismisses.
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is inert while closed', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} startOpen={false} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes both listeners on unmount', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    cleanup();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
