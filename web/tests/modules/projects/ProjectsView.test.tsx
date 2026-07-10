import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([{ id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '', pr_enabled: null }])),
  http.get('*/api/projects/1/git', () => HttpResponse.json({ isRepo: true, status: { branch: 'master', ahead: 0, behind: 0, dirty: 3, clean: false }, branches: [{ name: 'master', current: true }], commits: [{ hash: 'deadbee', subject: 'feat: x', author: 'me', relative: '2 hours ago' }] })),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('ProjectsView', () => {
  it('lists projects and shows git on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const row = await screen.findByText('elowen');
    fireEvent.click(row);
    expect(await screen.findByText('master')).toBeTruthy();
    expect(await screen.findByText('feat: x')).toBeTruthy();
  });

  it('selects a project with Space', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    const card = (await screen.findByText('elowen')).closest('[role="button"]')!;
    fireEvent.keyDown(card, { key: ' ' });
    expect(await screen.findByText('master')).toBeTruthy();
  });
});
