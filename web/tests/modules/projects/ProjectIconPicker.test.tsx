import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ProjectIconPicker } from '../../../modules/projects/ProjectIconPicker';
import { ProjectIcon } from '../../../components/ui/ProjectIcon';

// A managed project keeps its files inside its environment, not on a host path. The editor's project
// file and raw routes already read a managed project through the guest filesystem, and the daemon
// validates a chosen icon path inside that same environment before it persists — so the picker needs
// nothing managed-specific. What it must never do is reach for a host path or a host fallback.
const managed = { id: 7, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' as const };
const requested: { files: number; raw: string[]; patched: unknown[] } = { files: 0, raw: [], patched: [] };
const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([
    { name: 'editor', url: '/plugins/editor/web/hash.js', apiVersion: 4, nav: [], account: [], user: [], project: [], settings: [], strings: {} },
  ])),
  http.get('*/api/projects/7/files', () => {
    requested.files += 1;
    return HttpResponse.json([
      { path: 'assets/logo.png', type: 'file' },
      { path: 'docs/diagram.svg', type: 'file' },
      { path: 'README.md', type: 'file' },
    ]);
  }),
  http.get('*/api/projects/7/raw', ({ request }) => {
    requested.raw.push(new URL(request.url).searchParams.get('path') ?? '');
    return new HttpResponse(new Blob([new Uint8Array([137, 80, 78, 71])]), { headers: { 'content-type': 'image/png' } });
  }),
  http.patch('*/api/projects/7', async ({ request }) => {
    requested.patched.push(await request.json());
    return HttpResponse.json({ ...managed, icon: 'assets/logo.png' });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); requested.files = 0; requested.raw = []; requested.patched = []; });
afterAll(() => server.close());

function mount(node: React.ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider>{node}</ToastProvider></Wrapper>);
}

describe('project icon from a managed workspace', () => {
  it('lists the images inside the environment and persists the chosen one as a project-relative path', async () => {
    mount(<ProjectIconPicker project={managed} onClose={() => {}} />);

    const dialog = within(await screen.findByRole('dialog', { name: 'Choose icon' }));
    expect(await dialog.findByTitle('assets/logo.png')).toBeInTheDocument();
    expect(dialog.getByTitle('docs/diagram.svg')).toBeInTheDocument();
    // Grouped by the directory they live in, exactly as a host project's images are.
    expect(dialog.getByText('assets')).toBeInTheDocument();
    // Only images, and only from the project's own guest filesystem.
    expect(dialog.queryByTitle('README.md')).toBeNull();
    expect(requested.files).toBe(1);

    fireEvent.click(dialog.getByTitle('assets/logo.png'));
    fireEvent.click(dialog.getByRole('button', { name: 'Select' }));

    // A path relative to the project, which the daemon then resolves and stats inside the environment.
    await waitFor(() => expect(requested.patched).toEqual([{ icon: 'assets/logo.png' }]));
    expect(requested.raw.every((path) => !path.startsWith('/'))).toBe(true);
  });

  it('renders a persisted managed icon from the same authorized guest route', async () => {
    mount(<ProjectIcon project={{ id: 7, icon: 'assets/logo.png' }} size={24} />);
    await waitFor(() => expect(requested.raw).toEqual(['assets/logo.png']));
    const image = await screen.findByRole('presentation', { hidden: true }).catch(() => null);
    expect(image ?? document.querySelector('[data-project-icon="assets/logo.png"]')).toBeTruthy();
  });

  it('reports a refused read instead of falling back to anything on the host', async () => {
    server.use(http.get('*/api/projects/7/files', () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
    mount(<ProjectIconPicker project={managed} onClose={() => {}} />);

    const dialog = within(await screen.findByRole('dialog', { name: 'Choose icon' }));
    expect(await dialog.findByText(/forbidden/i)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Select' })).toBeDisabled();
    expect(requested.patched).toEqual([]);
  });
});
