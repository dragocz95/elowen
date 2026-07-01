import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { AgentConstellation } from '../../../modules/dashboard/AgentConstellation';
import { createWrapper } from '../../test-utils';
import type { SessionInfo, Task } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const agent = (name: string): SessionInfo => ({ name, role: 'agent', agent: 'sonnet' });

describe('AgentConstellation', () => {
  it('renders a node per live agent by friendly name and links to the sessions view', () => {
    const { wrapper: Wrapper } = createWrapper();
    const sessions = [agent('orca-Iris'), agent('orca-Vega')];
    render(<Wrapper><AgentConstellation sessions={sessions} signals={{}} tasks={[] as Task[]} /></Wrapper>);
    const iris = screen.getByText('Iris');
    expect(iris).toBeTruthy();
    expect(screen.getByText('Vega')).toBeTruthy();
    expect(iris.closest('a')?.getAttribute('href')).toBe('/sessions');
    expect(screen.getByText('Agent map')).toBeTruthy();
  });

  it('shows a radar empty state when no agents are on watch', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><AgentConstellation sessions={[]} signals={{}} tasks={[] as Task[]} /></Wrapper>);
    expect(screen.getByText('No agents on watch')).toBeTruthy();
  });

  it('ignores non-agent sessions (overseer/pilot)', () => {
    const { wrapper: Wrapper } = createWrapper();
    const sessions: SessionInfo[] = [agent('orca-Iris'), { name: 'orca-overseer', role: 'overseer', agent: 'sonnet' }];
    render(<Wrapper><AgentConstellation sessions={sessions} signals={{}} tasks={[] as Task[]} /></Wrapper>);
    expect(screen.getByText('Iris')).toBeTruthy();
    expect(screen.queryByText('overseer')).toBeNull();
  });
});
