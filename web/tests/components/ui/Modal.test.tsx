import { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { Modal, ModalFooter } from '../../../components/ui/Modal';
import { WorkspaceDetailRail } from '../../../components/ui/WorkspacePrimitives';
import { PHONE_MAX_WIDTH } from '../../../lib/breakpoints';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

/** Answer the phone media query the way a phone would, so the presentation rule resolves as it does on a
 *  device jsdom cannot lay out. */
function asPhone(width = PHONE_MAX_WIDTH) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: /max-width:\s*(\d+)px/.test(query) && width <= Number(/max-width:\s*(\d+)px/.exec(query)![1]),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList);
}

afterEach(() => vi.restoreAllMocks());

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

  /** A `click` fires on the common ancestor of the press and the release, so a press that starts on a
   *  control inside the dialog and ends anywhere else arrives at the backdrop with `target ===
   *  currentTarget` — indistinguishable, by that check alone, from a real backdrop click. Radix Select
   *  makes it the normal case rather than an edge one: opening it sets `pointer-events: none` on the
   *  body, the release stops hit-testing onto the trigger, and the click surfaces on the backdrop. That
   *  closed the whole dialog the moment anyone opened a picker inside it. */
  it('does not dismiss when a press begins on a control inside it and the click lands on the backdrop', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Nová vzpomínka" onClose={onClose}>
        <button type="button">picker</button>
      </Modal>,
      { wrapper: W },
    );
    const backdrop = document.querySelector('.overlay-layer-modal')!;
    fireEvent.pointerDown(screen.getByRole('button', { name: 'picker' }));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    // A press that really does begin on the backdrop still dismisses.
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('keeps large code and diff dialogs inside a visible desktop frame', () => {
    render(
      <Modal title="Code diff" size="lg" presentation="center" onClose={vi.fn()}>
        <span>diff</span>
      </Modal>,
      { wrapper: W },
    );

    expect(screen.getByRole('dialog', { name: 'Code diff' })).toHaveClass('max-w-[90rem]');
  });

  it('opens the first overlay as a drawer and anything raised from inside it as a centered window', () => {
    render(
      <Modal title="First" size="md" onClose={vi.fn()}>
        <Modal title="Second" size="md" onClose={vi.fn()}><span>nested</span></Modal>
      </Modal>,
      { wrapper: W },
    );

    // Queried through the DOM rather than by role: the overlay stack correctly makes the outer dialog
    // inert once the inner one opens, which takes it out of the accessibility tree.
    const [first, second] = Array.from(document.querySelectorAll('[data-elowen-modal]'));

    // The first click out of a section is a rail; the step taken FROM it is a window. Neither call
    // site says so — the rule is resolved from overlay depth, so it cannot be got wrong one row at a
    // time, which is exactly how the two presentations drifted apart before.
    expect(first).toHaveClass('animate-drawer-in');
    expect(second).not.toHaveClass('animate-drawer-in');
    expect(second).toHaveClass('max-w-lg');
  });

  it('gives a drawer the room a large centered dialog would have had', () => {
    render(
      <Modal title="Wide" size="lg" onClose={vi.fn()}><span>table</span></Modal>,
      { wrapper: W },
    );

    expect(screen.getByRole('dialog', { name: 'Wide' })).toHaveClass('w-[min(72rem,calc(100vw-3rem))]');
  });

  it('reuses the accessible dialog shell for fullscreen content and header actions', () => {
    render(
      <Modal title="Diagnostics" presentation="fullscreen" headerActions={<button type="button">Refresh data</button>} onClose={vi.fn()}>
        <span>workspace</span>
      </Modal>,
      { wrapper: W },
    );

    const dialog = screen.getByRole('dialog', { name: 'Diagnostics' });
    expect(dialog).toHaveClass('w-full', 'relative');
    expect(screen.getByRole('button', { name: 'Refresh data' })).toBeInTheDocument();
  });

  it('renders above workspace detail drawers and keeps the drawer open when the nested modal handles Escape', () => {
    function Harness() {
      const [drawerOpen, setDrawerOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(true);
      return (
        <>
          {drawerOpen ? <WorkspaceDetailRail label="User detail" closeLabel="Close detail" onClose={() => setDrawerOpen(false)}>detail</WorkspaceDetailRail> : null}
          {modalOpen ? <Modal title="Manage tools" onClose={() => setModalOpen(false)}>picker</Modal> : null}
        </>
      );
    }
    render(<Harness />, { wrapper: W });
    const modal = screen.getByRole('dialog', { name: 'Manage tools' });
    expect(modal.parentElement).toHaveClass('overlay-layer-modal');

    fireEvent.keyDown(modal, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Manage tools' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'User detail' })).toBeInTheDocument();
  });

  it('stacks status and wraps actions on narrow modal widths', () => {
    render(
      <ModalFooter status={<span>Saved</span>}>
        <button type="button">Delete project</button>
        <button type="button">Cancel</button>
        <button type="button">Save changes</button>
      </ModalFooter>,
    );
    expect(screen.getByText('Saved').parentElement).toHaveClass('min-w-0', 'w-full', 'sm:w-auto');
    expect(screen.getByRole('button', { name: 'Delete project' }).parentElement).toHaveClass('flex-wrap');
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

  // Radix listens for Escape on the DOCUMENT, which is where a real keypress arrives after bubbling out
  // of whatever had focus. `window` is one step further up and nothing propagates back down to it, so the
  // event has to be raised on an element the way the browser raises it.
  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test Modal" onClose={onClose}>
        <span>content</span>
      </Modal>,
      { wrapper: W },
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Test Modal' }), { key: 'Escape' });
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
    // Press AND release on the backdrop. A bare click is not a sequence a browser produces, and the
    // backdrop deliberately only dismisses on a press that began on it — see the regression above.
    fireEvent.pointerDown(overlay);
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

  it('moves focus into the dialog and restores it to the opener when closed', async () => {
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
    // Radix's focus scope hands focus back a tick after the surface is gone, so that its own trap is
    // already torn down and cannot pull the restored focus back inside the dialog it is unmounting.
    await waitFor(() => expect(opener).toHaveFocus());
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

    // Raised on the focused control, not on `window`: the trap is Radix's focus scope now, and it reads
    // the key off the dialog the event bubbles through — which is the path a real Tab takes.
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('only closes the topmost nested modal and restores focus inside its parent', async () => {
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

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Child modal' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Child modal' })).not.toBeInTheDocument();
    const parent = screen.getByRole('dialog', { name: 'Parent modal' });
    await waitFor(() => expect(childOpener).toHaveFocus());

    fireEvent.keyDown(parent, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Parent modal' })).not.toBeInTheDocument();
    await waitFor(() => expect(outerOpener).toHaveFocus());
  });

  it('leaves a nested overlay live and inerts only the layers underneath it', () => {
    render(
      <Modal title="Parent inert" onClose={vi.fn()}>
        <Modal title="Child inert" onClose={vi.fn()}><span>nested</span></Modal>
      </Modal>,
      { wrapper: W },
    );

    const [parentLayer, childLayer] = Array.from(document.querySelectorAll('[data-slot="dialog-overlay"]'));
    // The stack, not Radix, owns this: `inert` takes the background out of the tab order and out of
    // reach of a pointer, which `aria-hidden` alone never does.
    expect(parentLayer).toHaveAttribute('inert');
    expect(childLayer).not.toHaveAttribute('inert');

    // And the child is INSIDE that live layer rather than portaled to a body child of its own — which is
    // what would happen with Radix's `Dialog.Portal` and would leave it to be marked inert by the stack.
    const [, child] = Array.from(document.querySelectorAll('[data-elowen-modal]'));
    expect(child!.parentElement).toBe(childLayer);
    expect(child!.closest('[inert]')).toBeNull();
    expect(screen.getByText('nested').closest('[data-elowen-modal]')).toBe(child);
  });

  // Two systems now write `aria-hidden` on the page behind a dialog: this app's overlay stack, and the
  // `hideOthers()` Radix runs from inside its modal content. The stack goes first, in the commit phase,
  // precisely so that Radix finds the page already hidden, records it as none of its business and never
  // clears it — and so that the stack records the page's REAL prior state rather than Radix's. Get that
  // order wrong and the last overlay to close leaves the whole app announced as hidden, permanently.
  it('hands the page back exactly as it found it when the last overlay closes', () => {
    const background = document.body.appendChild(document.createElement('div'));
    const priorOverflow = document.body.style.overflow;

    const { unmount } = render(<Modal title="Isolating" onClose={vi.fn()}><span>body</span></Modal>, { wrapper: W });
    expect(background).toHaveAttribute('inert');
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(background).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('aria-hidden');
    expect(document.body.style.overflow).toBe(priorOverflow);
    background.remove();
  });

  // The toast dock is the one surface that has to contradict the isolation: `--z-toast` (130) sits above
  // `--z-modal` (100) precisely so a message about what just happened stays readable over the thing that
  // caused it, and an error raised BY a dialog is that case. Swept up with the rest of the page it paints
  // above the dialog while being unclickable and unannounced.
  //
  // Two independent sweeps hide the page behind a dialog and each has its own opt-out, so a surface that
  // has to survive BOTH says so twice: `data-overlay-exempt` for this app's stack, and `aria-live` for
  // the `hideOthers()` pass Radix runs from inside its modal content, which spares live regions and
  // nothing else. With only the first, the node comes out interactive but still `aria-hidden` — which is
  // the same defect wearing a different attribute.
  it('leaves a surface marked live-over-overlays out of the isolation sweep', () => {
    const live = document.body.appendChild(document.createElement('div'));
    live.setAttribute('data-overlay-exempt', '');
    live.setAttribute('aria-live', 'polite');
    const ordinary = document.body.appendChild(document.createElement('div'));

    const { unmount } = render(<Modal title="Isolating" onClose={vi.fn()}><span>body</span></Modal>, { wrapper: W });
    expect(ordinary).toHaveAttribute('inert');
    expect(live).not.toHaveAttribute('inert');
    expect(live).not.toHaveAttribute('aria-hidden');

    unmount();
    // And nothing was recorded against it, so nothing is written back to it either.
    expect(live).not.toHaveAttribute('inert');
    expect(live).not.toHaveAttribute('aria-hidden');
    live.remove();
    ordinary.remove();
  });

  it('keeps the phone fullscreen presentation on the Radix surface', () => {
    asPhone();
    render(<Modal title="Phone dialog" onClose={vi.fn()}><span>body</span></Modal>, { wrapper: W });

    const dialog = screen.getByRole('dialog', { name: 'Phone dialog' });
    expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
    // `.overlay-surface[data-presentation]` in primitives.css owns the dvh height and the safe-area
    // insets for every overlay, so the class has to land on the element Radix renders, not on a wrapper.
    expect(dialog).toHaveClass('overlay-surface');
    expect(dialog.parentElement).toHaveClass('overlay-layer-modal');
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
    fireEvent.pointerDown(child.parentElement!);
    fireEvent.click(child.parentElement!);

    expect(screen.queryByRole('dialog', { name: 'Child backdrop modal' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent backdrop modal' })).toBeInTheDocument();
  });
});
