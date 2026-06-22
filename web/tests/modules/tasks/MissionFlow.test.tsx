import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MissionFlow } from '../../../modules/tasks/MissionFlow';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const epic: Task = { id: 'ep1', title: 'Ship the dashboard', type: 'epic', status: 'in_progress' };
const phases: Task[] = [
  { id: 'p1', title: 'Scaffold API', type: 'task', status: 'closed', outcome: 'ok', parent_id: 'ep1', labels: ['exec:sonnet', 'agent:Nova'] },
  { id: 'p2', title: 'Wire the UI', type: 'task', status: 'in_progress', parent_id: 'ep1', labels: ['exec:opus', 'agent:Juno'] },
  { id: 'p3', title: 'Polish', type: 'task', status: 'open', parent_id: 'ep1', labels: [] },
];

describe('MissionFlow', () => {
  it('renders the epic and every phase with its model and agent', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><MissionFlow epic={epic} phases={phases} onSelectPhase={() => {}} /></Wrapper>);
    expect(screen.getByText('Ship the dashboard')).toBeTruthy();
    expect(screen.getByText('Scaffold API')).toBeTruthy();
    expect(screen.getByText('Wire the UI')).toBeTruthy();
    expect(screen.getByText('Polish')).toBeTruthy();
    // model + agent chips surface on phases that carry them
    expect(screen.getByText('sonnet')).toBeTruthy();
    expect(screen.getByText('Nova')).toBeTruthy();
    expect(screen.getByText('Juno')).toBeTruthy();
  });

  it('calls onSelectPhase with the phase id when a phase node is clicked', () => {
    const onSelectPhase = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><MissionFlow epic={epic} phases={phases} onSelectPhase={onSelectPhase} /></Wrapper>);
    fireEvent.click(screen.getByText('Wire the UI'));
    expect(onSelectPhase).toHaveBeenCalledWith('p2');
  });
});
