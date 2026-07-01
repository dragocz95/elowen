import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { LiveMissions } from '../../../modules/dashboard/LiveMissionCard';
import { createWrapper } from '../../test-utils';
import type { Mission, Task } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/missions/:id/changed-files', () => HttpResponse.json([{ path: 'src/app.ts', added: 10, deleted: 2 }])),
  http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: 'running tests\nall passed' })),
  http.get('*/api/tasks/:id/usage', () => HttpResponse.json({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 1.25 })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const noop = () => {};
const mission: Mission = { id: 'm1', epic_id: 'e1', autonomy: 'L1', max_sessions: 2, state: 'active' };
const tasks: Task[] = [
  { id: 'e1', title: 'Ship feature', status: 'in_progress' },
  { id: 'p1', parent_id: 'e1', title: 'Phase one', status: 'in_progress', labels: ['agent:Iris', 'exec:sonnet'] },
];

function renderCard(overrides: Partial<Parameters<typeof LiveMissions>[0]> = {}) {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper>
      <LiveMissions
        missions={[mission]} tasks={tasks} sessionNames={['orca-Iris']} signals={{}}
        onPause={noop} onResume={noop} onDisengage={noop}
        isLoading={false} isError={false} onRetry={noop}
        {...overrides}
      />
    </Wrapper>,
  );
}

describe('LiveMissions', () => {
  it('renders the active mission with its running phase, changed files and rolled-up cost', async () => {
    renderCard();
    expect(screen.getByText('Ship feature')).toBeTruthy();
    expect(screen.getByText('Phase one')).toBeTruthy();
    expect(await screen.findByText('app.ts')).toBeTruthy();
    expect(screen.getByText('+10')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    expect(await screen.findByText(/all passed/)).toBeTruthy();
  });

  it('shows the empty state when there are no active missions', () => {
    renderCard({ missions: [{ ...mission, state: 'disengaged' }] });
    expect(screen.getByText('No active missions.')).toBeTruthy();
  });
});
