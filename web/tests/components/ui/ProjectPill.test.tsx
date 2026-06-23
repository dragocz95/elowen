import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectPill } from '../../../components/ui/ProjectPill';
import { createWrapper } from '../../test-utils';
import type { Project } from '../../../lib/types';

const TWO: Project[] = [
  { id: 1, slug: 'orca', path: '/var/www/orca', notes: '', icon: '' },
  { id: 2, slug: 'hermes', path: '/var/www/hermes', notes: '', icon: '' },
];

function projectsHandler(projects: Project[]) {
  return http.get('*/api/projects', () => HttpResponse.json(projects));
}

const server = setupServer(projectsHandler(TWO));
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers(projectsHandler(TWO)));
afterAll(() => server.close());

describe('ProjectPill', () => {
  it('renders the matching project slug when there are 2+ projects', async () => {
    const { wrapper: W } = createWrapper();
    const { container } = render(<W><ProjectPill projectId={2} /></W>);
    await waitFor(() => expect(container.textContent).toContain('hermes'));
  });

  it('renders nothing when the project id cannot be resolved', async () => {
    const { wrapper: W } = createWrapper();
    const { container } = render(<W><ProjectPill projectId={99} /></W>);
    // Give the query time to settle; an unknown id resolves to no pill.
    await waitFor(() => expect(container.textContent).not.toContain('orca'));
    expect(container.querySelector('span')).toBeNull();
  });

  it('hides itself when there is only a single project (noise)', async () => {
    server.use(projectsHandler([TWO[0]]));
    const { wrapper: W } = createWrapper();
    const { container } = render(<W><ProjectPill projectId={1} /></W>);
    // Even after the projects load, a lone project yields no pill.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('span')).toBeNull();
  });

  it('shows the lone project when `always` is set (session cards confirm the working dir)', async () => {
    server.use(projectsHandler([TWO[0]]));
    const { wrapper: W } = createWrapper();
    const { container } = render(<W><ProjectPill projectId={1} always /></W>);
    await waitFor(() => expect(container.textContent).toContain('orca'));
  });

  it('renders nothing when no project id is given', () => {
    const { wrapper: W } = createWrapper();
    const { container } = render(<W><ProjectPill /></W>);
    expect(container.querySelector('span')).toBeNull();
  });
});
