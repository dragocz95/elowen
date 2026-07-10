import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { Modal } from '../../../components/ui/Modal';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('Modal', () => {
  it('renders title and children', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>modal-body</span>
      </Modal>,
      { wrapper: W },
    );
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('modal-body')).toBeInTheDocument();
  });

  it('exposes a labelled modal dialog', () => {
    render(
      <Modal title="Accessible title" description="Dialog context" onClose={vi.fn()}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );

    const dialog = screen.getByRole('dialog', { name: 'Accessible title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Dialog context');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );
    // The modal portals to <body>, so reach the backdrop from the document, not the render container.
    const overlay = document.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when clicking inside the modal box', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );
    fireEvent.click(screen.getByText('content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog and restores it to the opener when closed', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open modal</button>
          {open ? (
            <Modal title="Focus modal" onClose={() => setOpen(false)}>
              <button type="button">Modal action</button>
            </Modal>
          ) : null}
        </>
      );
    }

    render(<Harness />, { wrapper: W });
    const opener = screen.getByRole('button', { name: 'Open modal' });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole('dialog', { name: 'Focus modal' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });

  it('honours an explicitly requested initial focus target', () => {
    render(
      <Modal title="Initial focus" onClose={vi.fn()}>
        <button type="button" data-autofocus>Preferred action</button>
      </Modal>,
      { wrapper: W },
    );

    expect(screen.getByRole('button', { name: 'Preferred action' })).toHaveFocus();
  });

  it('traps Tab and Shift+Tab within the topmost dialog', () => {
    render(
      <Modal title="Focus trap" onClose={vi.fn()}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>,
      { wrapper: W },
    );

    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('only closes the topmost nested modal and restores focus inside its parent', () => {
    function NestedHarness() {
      const [parentOpen, setParentOpen] = useState(false);
      const [childOpen, setChildOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setParentOpen(true)}>Open parent</button>
          {parentOpen ? (
            <Modal title="Parent modal" onClose={() => setParentOpen(false)}>
              <button type="button" onClick={() => setChildOpen(true)}>Open child</button>
              {childOpen ? (
                <Modal title="Child modal" onClose={() => setChildOpen(false)}>
                  <span>Child content</span>
                </Modal>
              ) : null}
            </Modal>
          ) : null}
        </>
      );
    }

    render(<NestedHarness />, { wrapper: W });
    const outerOpener = screen.getByRole('button', { name: 'Open parent' });
    outerOpener.focus();
    fireEvent.click(outerOpener);
    const childOpener = screen.getByRole('button', { name: 'Open child' });
    childOpener.focus();
    fireEvent.click(childOpener);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Child modal' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent modal' })).toBeInTheDocument();
    expect(childOpener).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Parent modal' })).not.toBeInTheDocument();
    expect(outerOpener).toHaveFocus();
  });

  it('does not close a parent when a nested modal backdrop is clicked', () => {
    function NestedBackdropHarness() {
      const [childOpen, setChildOpen] = useState(true);
      return (
        <Modal title="Parent backdrop modal" onClose={vi.fn()}>
          {childOpen ? (
            <Modal title="Child backdrop modal" onClose={() => setChildOpen(false)}>
              <span>Nested content</span>
            </Modal>
          ) : null}
        </Modal>
      );
    }

    render(<NestedBackdropHarness />, { wrapper: W });
    const child = screen.getByRole('dialog', { name: 'Child backdrop modal' });
    fireEvent.click(child.parentElement!);

    expect(screen.queryByRole('dialog', { name: 'Child backdrop modal' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent backdrop modal' })).toBeInTheDocument();
  });
});
