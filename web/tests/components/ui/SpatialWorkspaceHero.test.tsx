import { render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { SpatialWorkspaceHero, WorkspaceMetric } from '../../../components/ui/WorkspacePrimitives';
import { ControlSurfaceDocument, ControlSurfaceState, ControlSurfaceToolbar } from '../../../components/ui/ControlSurface';

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
        <ControlSurfaceState>Empty</ControlSurfaceState>
      </ControlSurfaceDocument>,
    );
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    expect(screen.getByText('Filters')).toHaveClass('control-surface-toolbar');
    expect(screen.getByText('Empty')).toHaveClass('control-surface-state');
  });
});
