import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { SpatialWorkspaceHero, SpatialWorkspaceLayout, WorkspaceDetailRail, WorkspaceMetric } from '../../../components/ui/WorkspacePrimitives';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../../../components/ui/ControlSurface';
import { LanguageProvider } from '../../../lib/i18n';

/** The detail rail is `Modal` now, and `Modal` reads the app's translations for the header it draws —
 *  the same provider every other overlay test mounts under, and the same one the plugin UI runtime
 *  already required of every bundle that mounts `Modal` from it. */
function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('SpatialWorkspaceHero', () => {
  it('composes one mascot, identity, status, primary action and metrics', () => {
    render(
      <SpatialWorkspaceHero
        eyebrow="Control"
        title="Tasks"
        count={12}
        description="Manage work"
        mascotState="idle"
        status={<span>Ready</span>}
        action={<button type="button"><Plus />New task</button>}
      >
        <WorkspaceMetric label="Active" value={4} />
      </SpatialWorkspaceHero>,
    );

    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New task/ })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('provides one neutral warm document contract for toolbars and states', () => {
    const { container } = render(
      <ControlSurfaceDocument>
        <ControlSurfaceToolbar>Filters</ControlSurfaceToolbar>
        <ControlSurfaceRegister>Rows</ControlSurfaceRegister>
        <ControlSurfaceState>Empty</ControlSurfaceState>
      </ControlSurfaceDocument>,
    );
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    expect(screen.getByText('Filters')).toHaveClass('control-surface-toolbar');
    expect(screen.getByText('Rows')).toHaveClass('control-surface-register');
    expect(screen.getByText('Empty')).toHaveClass('control-surface-state');
  });

  it('composes the canonical workspace frame with an optional primary rail', () => {
    render(
      <SpatialWorkspaceLayout
        hero={{ eyebrow: 'Work', title: 'Sessions', description: 'Live work', metrics: <WorkspaceMetric label="Live" value={3} /> }}
        navigation={{
          ariaLabel: 'Session view',
          value: 'live',
          onChange: () => undefined,
          sections: [{ id: 'live', label: 'Live', icon: Plus }, { id: 'brain', label: 'Brain', icon: Plus }],
        }}
      >
        <ControlSurfaceDocument>Register</ControlSurfaceDocument>
      </SpatialWorkspaceLayout>,
    );

    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Session view' })).toBeInTheDocument();
    expect(screen.getByText('Register')).toHaveAttribute('data-control-surface');
    expect(screen.getByTestId('spatial-workspace-layout')).toContainElement(screen.getByText('Register'));
  });

  it('opens the detail rail on the shared overlay foundation rather than a second drawer of its own', () => {
    render(
      <WorkspaceDetailRail label="Task detail" closeLabel="Close detail" onClose={vi.fn()}>
        Detail body
      </WorkspaceDetailRail>,
      { wrapper: W },
    );

    const rail = screen.getByRole('dialog', { name: 'Task detail' });
    // The whole point of the collapse: this is `Modal` with `intent="inspect"`, so the rail is made of
    // the same material and the same geometry as every other overlay. It used to be a second
    // implementation with its own surface class, backdrop element and paint in workspace-detail.css —
    // which is how it ended up a different colour from the dialog it opens into.
    expect(rail).toHaveClass('overlay-surface');
    expect(rail).toHaveAttribute('data-presentation', 'drawer');
    expect(rail).toHaveClass('animate-drawer-in');
    // A browsing surface keeps the first-level drawer width; `Modal` widens a drawer only for `size="lg"`.
    expect(rail).toHaveClass('w-[min(38rem,calc(100vw-3rem))]');
    // And `intent="inspect"` is what puts it on the drawer z-band, below the modal band an editing
    // dialog raised FROM it takes.
    expect(rail.parentElement).toHaveClass('overlay-layer-drawer');
    // The caller's own close label still names the shared header's control.
    expect(screen.getByRole('button', { name: 'Close detail' })).toBeInTheDocument();
    // The body is the one scroll region every overlay uses, containment included: a flick past the last
    // row must not chain into whatever scrolls behind the rail.
    expect(screen.getByText('Detail body')).toHaveClass('overflow-y-auto', 'overscroll-contain');
  });

  it('dismisses on Escape and on a press that began on the backdrop, but not on a drag released over it', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceDetailRail label="Task detail" closeLabel="Close" onClose={onClose}>
        <button type="button">Drawer action</button>
      </WorkspaceDetailRail>,
      { wrapper: W },
    );
    const rail = screen.getByRole('dialog', { name: 'Task detail' });
    const backdrop = rail.parentElement!;

    // A `click` fires on the common ancestor of the press and the release, so a press that starts on a
    // control inside the rail and ends anywhere else arrives at the backdrop with
    // `target === currentTarget`. The rail used to close on a bare `mousedown` and had no way to tell
    // the two apart; it now inherits the dialog's press-began-on-the-backdrop rule.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Drawer action' }));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Radix listens for Escape on the document, which is where a real keypress arrives after bubbling
    // out of whatever had focus.
    fireEvent.keyDown(rail, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the drawer, isolates the app root and restores focus on unmount', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open detail';
    document.body.append(opener);
    opener.focus();
    const { container, unmount } = render(
      <WorkspaceDetailRail label="Task detail" closeLabel="Close" onClose={() => {}}>
        <button type="button">Drawer action</button>
      </WorkspaceDetailRail>,
      { wrapper: W },
    );

    expect(screen.getByRole('dialog', { name: 'Task detail' })).toHaveFocus();
    expect(container).toHaveAttribute('inert');
    unmount();
    // Radix's focus scope releases a tick after the surface is gone, so that its own trap is already
    // torn down and cannot pull the restored focus back inside the drawer it is unmounting.
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});
