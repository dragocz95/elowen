import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MissionProgressView } from '../../../modules/missions/MissionProgressView';
import { createWrapper } from '../../test-utils';

const detail = {
  mission: { id: 'm1', epic_id: 'epic', autonomy: 'low', max_sessions: 1, cleared_guardrails: [], state: 'active' },
  epic: { id: 'epic', title: 'Build the thing', status: 'open', type: 'epic', parent_id: null },
  tasks: [
    { id: 'a', title: 'Task A', status: 'closed', type: 'task', parent_id: 'epic' },
    { id: 'b', title: 'Task B', status: 'open', type: 'task', parent_id: 'epic' },
  ],
  deps: [{ taskId: 'b', dependsOnId: 'a' }],
  progress: { total: 2, open: 1, inProgress: 0, blocked: 0, closed: 1, cancelled: 0 },
};

const server = setupServer(http.get('*/missions/m1', () => HttpResponse.json(detail)));
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('MissionProgressView', () => {
  it('renders the epic title, progress and phased task cards', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><MissionProgressView missionId="m1" /></Wrapper>);
    expect(await screen.findByText('Build the thing')).toBeTruthy();
    expect(await screen.findByText('Task A')).toBeTruthy();
    expect(screen.getByText('Task B')).toBeTruthy();
    expect(screen.getByText(/Total/i)).toBeTruthy();
  });
});
