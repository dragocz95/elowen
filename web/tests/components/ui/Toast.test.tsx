import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { Modal } from '../../../components/ui/Modal';
import { ToastProvider, useToast } from '../../../components/ui/Toast';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

const MESSAGE = 'Launched elowen-A';

function Trigger({ tone }: { tone?: 'ok' | 'error' }) {
  const { toast } = useToast();
  return <button onClick={() => toast(MESSAGE, tone)}>go</button>;
}

/** Every query is scoped to the viewport rather than the whole document, because Radix also renders a
 *  visually-hidden live region for each toast and portals THAT one to `<body>`. It carries the same
 *  words, so an unscoped `getByText` is ambiguous the moment the announcement is filled in. */
const dock = () => document.querySelector<HTMLElement>('[data-slot="toast-viewport"]')!;
const card = (node: HTMLElement) => node.closest<HTMLElement>('[data-slot="toast"]');

describe('Toast', () => {
  it('shows a toast message when fired', async () => {
    render(<ToastProvider><Trigger /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(await within(dock()).findByText(MESSAGE)).toBeInTheDocument();
  });

  /** The role is the app's policy and not Radix's — a Radix toast carries no role of its own. An error
   *  interrupts (`alert`, assertive), anything else waits its turn (`status`, polite). */
  it.each([
    ['ok', 'status'],
    ['error', 'alert'],
  ] as const)('gives a %s toast role="%s"', async (tone, role) => {
    render(<ToastProvider><Trigger tone={tone} /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(card(await within(dock()).findByText(MESSAGE))).toHaveAttribute('role', role);
  });

  it('is dismissed by its close button', async () => {
    render(<ToastProvider><Trigger /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    const toast = card(await within(dock()).findByText(MESSAGE))!;

    // The close button is the only button a toast contains, so this needs no locale-specific label.
    fireEvent.click(within(toast).getByRole('button'));
    // Radix takes the toast down on the click itself, but assert through `waitFor` rather than a bare
    // expect: a close that only settles a frame later is still correct, and should not read as a failure.
    await waitFor(() => { expect(within(dock()).queryByText(MESSAGE)).not.toBeInTheDocument(); });
  });

  /** --z-toast sits above --z-modal so a message about what just happened stays readable over the dialog
   *  that caused it. A z-index only buys that if the dock is NOT a descendant of the modal: the modal's
   *  own layer is a stacking context, and nothing inside it can paint above it however high it stacks.
   *  This is the structural half of that guarantee — the half jsdom can actually see. */
  it('raises a toast above an open modal rather than inside it', async () => {
    function Raiser() {
      const { toast } = useToast();
      return (
        <Modal title="Runtime limits" onClose={vi.fn()}>
          <button onClick={() => toast(MESSAGE)}>save</button>
        </Modal>
      );
    }
    render(<ToastProvider><Raiser /></ToastProvider>, { wrapper: W });
    fireEvent.click(await screen.findByRole('button', { name: 'save' }));

    const toast = card(await within(dock()).findByText(MESSAGE))!;
    const modal = document.querySelector('.overlay-layer-modal')!;

    expect(modal).toBeInTheDocument();
    expect(dock()).toHaveClass('overlay-toast-dock');
    expect(dock().contains(toast)).toBe(true);
    expect(modal.contains(dock())).toBe(false);
  });
});
