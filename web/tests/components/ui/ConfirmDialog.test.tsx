import { describe, it, expect, vi } from 'vitest';
import { Activity, StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Modal } from '../../../components/ui/Modal';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

/** Radix arms its outside-press detection on a `setTimeout(0)` after mount, so that the very click that
 *  opened an overlay cannot immediately close it again. A test that presses outside before that has
 *  happened proves nothing at all. */
const armOutsidePress = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0); }));

/** The full press a browser sends when someone clicks the backdrop. */
function pressOutside(layer: HTMLElement) {
  fireEvent.pointerDown(layer);
  fireEvent.mouseDown(layer);
  fireEvent.mouseUp(layer);
  fireEvent.click(layer);
}

const backdrop = () => document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('ConfirmDialog', () => {
  it('renders title, description, confirm and cancel when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete model"
        description="Remove my/custom?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: W },
    );
    expect(screen.getAllByText('Delete model').length).toBeGreaterThan(0);
    expect(screen.getByText('Remove my/custom?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('puts initial focus on the safe Cancel action', async () => {
    render(<ConfirmDialog open title="Delete model" onConfirm={vi.fn()} onClose={vi.fn()} />, { wrapper: W });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('fires onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={vi.fn()} onClose={onClose} />, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={onConfirm} onClose={vi.fn()} />, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="Delete model" onConfirm={vi.fn()} onClose={vi.fn()} />,
      { wrapper: W },
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The reason this is an `AlertDialog` and not a `Dialog`. A confirmation asks one question about an
  // action already chosen, usually a destructive one; a stray press on the backdrop is not an answer to
  // it. Radix enforces that inside `AlertDialogContent`, so no call site can undo it.
  it('is NOT dismissed by pressing outside it, where a modal is', async () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={vi.fn()} onClose={onClose} />, { wrapper: W });
    await armOutsidePress();

    pressOutside(backdrop());
    expect(onClose).not.toHaveBeenCalled();

    // The same gesture on an ordinary dialog does close it — which is what makes the assertion above a
    // statement about the primitive rather than about a listener that was never attached.
    const dismissed = vi.fn();
    render(<Modal title="Ordinary dialog" onClose={dismissed}><span>body</span></Modal>, { wrapper: W });
    await armOutsidePress();
    const layers = document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]');
    pressOutside(layers[layers.length - 1]!);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  // Cancelling IS the safe answer, so the key that means "cancel" still works.
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={vi.fn()} onClose={onClose} />, { wrapper: W });
    fireEvent.keyDown(screen.getByRole('alertdialog', { name: 'Delete model' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks every dismissal path and shows the pending label while an async confirm runs', async () => {
    const request = deferred();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete model"
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={() => request.promise}
        onClose={onClose}
      />,
      { wrapper: W },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    fireEvent.keyDown(screen.getByRole('alertdialog', { name: 'Delete model' }), { key: 'Escape' });
    await armOutsidePress();
    pressOutside(backdrop());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { request.resolve(); await request.promise; });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('guards direct duplicate events before the pending render can disable the control', () => {
    const request = deferred();
    const onConfirm = vi.fn(() => request.promise);
    render(<ConfirmDialog open title="Delete model" onConfirm={onConfirm} onClose={vi.fn()} />, { wrapper: W });
    const confirm = screen.getByRole('button', { name: 'Delete' });

    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and reports an async confirmation error', async () => {
    const request = deferred();
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={() => request.promise} onClose={onClose} />, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await act(async () => { request.reject(new Error('Delete failed')); await request.promise.catch(() => undefined); });

    expect(screen.getByRole('alertdialog', { name: 'Delete model' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
  });

  it('reports completion after StrictMode re-runs the effect setup', async () => {
    const request = deferred();
    render(
      <StrictMode><W><ConfirmDialog open title="Delete model" onConfirm={() => request.promise} onClose={vi.fn()} /></W></StrictMode>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await act(async () => { request.reject(new Error('Strict failure')); await request.promise.catch(() => undefined); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Strict failure');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('reports completion after an Activity hide-show reactivates the same instance', async () => {
    const request = deferred();
    const view = (hidden: boolean) => (
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <W><ConfirmDialog open title="Delete model" onConfirm={() => request.promise} onClose={vi.fn()} /></W>
      </Activity>
    );
    const { rerender } = render(view(false));
    rerender(view(true));
    rerender(view(false));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await act(async () => { request.reject(new Error('Reactivated failure')); await request.promise.catch(() => undefined); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Reactivated failure');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});
