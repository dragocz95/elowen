import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { ProjectDetailTabs } from '../../../modules/projects/ProjectDetailTabs';

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{
    name: 'github', url: '/plugins/github/web/hash.js', apiVersion: 4, nav: [], account: [],
    project: [{ id: 'repository', label: 'GitHub', icon: 'Github' }], settings: [], strings: {},
  }])),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('ProjectDetailTabs', () => {
  beforeEach(() => {
    loadPluginUi.mockReset();
    loadPluginUi.mockResolvedValue({
      requiresApiVersion: 4,
      project: { repository: ({ project }: { project: { slug: string } }) => <div>Repository for {project.slug}</div> },
    });
  });

  it('mounts a plugin-declared panel for the selected Project without a core plugin branch', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ProjectDetailTabs project={{ id: 7, slug: 'demo', path: '/repo', notes: '', icon: '' }} isAdmin={false} overview={<div>Core overview</div>} /></Wrapper>);

    expect(await screen.findByText('Core overview')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('radio', { name: 'GitHub' }));
    expect(await screen.findByText('Repository for demo')).toBeInTheDocument();
    expect(loadPluginUi).toHaveBeenCalledWith('github', '/plugins/github/web/hash.js', undefined);
  });
});
