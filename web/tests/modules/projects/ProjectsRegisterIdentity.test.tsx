import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

/** The register's identity column and its team summary.
 *
 *  Both replaced columns of their own. The Path column spent a third of the register's width on
 *  monospaced strings that read the same at a glance, and the Summary column repeated one plugin pill
 *  per row; what is left is the project, who works on it, what it is using, and one quiet mark holding
 *  the exact location for the reader who actually wants it. */

const host = { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' };
const managed = { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed', guestRoot: '/analysis', adoptedPath: '/srv/legacy-analysis' };

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([host, managed])),
  http.get('*/api/projects/summary', () => HttpResponse.json([])),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/projects/:id/git', () => HttpResponse.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
};
const summaryOf = (members: unknown) => http.get('*/api/projects/summary', () => HttpResponse.json([{ projectId: 1, members, indicators: [] }]));

describe('project register identity and team', () => {
  // A column of buttons all called "Path" is unusable from an element list or from voice control, which
  // is why the mark is named for the project it belongs to rather than for what it holds.
  it('names the location mark for its own project and holds the whole host path behind it', async () => {
    mount();
    const mark = await screen.findByRole('button', { name: 'Host directory of elowen' });
    expect(mark).toHaveAttribute('data-project-location', 'host');
    // Nothing of the path is on the row until it is asked for.
    const row = mark.closest('[role="row"]') as HTMLElement;
    expect(row.textContent).not.toContain('/var/www/elowen');

    fireEvent.click(mark);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Host directory')).toBeInTheDocument();
    // The WHOLE path, not the ellipsised column it replaced.
    expect(within(tip).getByText('/var/www/elowen')).toBeInTheDocument();
    expect(mark).toHaveAttribute('aria-describedby', tip.id);
  });

  // A managed project has no host path. What it does have is the directory everything inside its
  // environment works from, and — when it was converted — where its contents came from.
  it('holds a managed environment identity behind the same mark', async () => {
    mount();
    const mark = await screen.findByRole('button', { name: 'Environment of analysis' });
    expect(mark).toHaveAttribute('data-project-location', 'managed');
    const row = mark.closest('[role="row"]') as HTMLElement;
    expect(row.textContent).not.toContain('/analysis');
    expect(row.textContent).not.toContain('Managed environment');

    fireEvent.click(mark);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Directory inside the environment')).toBeInTheDocument();
    expect(within(tip).getByText('/analysis')).toBeInTheDocument();
    expect(within(tip).getByText('Converted from')).toBeInTheDocument();
    expect(within(tip).getByText('/srv/legacy-analysis')).toBeInTheDocument();
  });

  // The mark sits inside a row that is itself one big open button. It has to take its own click, keep
  // its own focus ring, and never open the project by accident.
  it('keeps the location mark reachable by keyboard without opening the row', async () => {
    mount();
    const mark = await screen.findByRole('button', { name: 'Host directory of elowen' });
    expect(mark.closest('[role="row"]')).toHaveAttribute('aria-selected', 'false');

    fireEvent.focus(mark);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(mark);
    // Still a tip, still no drawer: the row's open control did not receive the activation.
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();
    expect(mark.closest('[role="row"]')).toHaveAttribute('aria-selected', 'false');
  });

  it('opens from the identity surface and keeps the team beside the project name', async () => {
    server.use(summaryOf({ total: 2, samples: [
      { id: 2, username: 'bob', name: 'Bob Novak', avatar: '' },
      { id: 3, username: 'ada', name: 'Ada Křížová', avatar: '' },
    ] }));
    mount();
    const location = await screen.findByRole('button', { name: 'Host directory of elowen' });
    const row = location.closest('[role="row"]') as HTMLElement;
    const projectName = within(row).getByText('elowen');
    const identityCell = projectName.closest('[role="cell"]');
    const team = within(row).getByRole('button', { name: '2 assigned users' });

    expect(team.closest('[role="cell"]')).toBe(identityCell);
    fireEvent.click(team);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();

    fireEvent.click(projectName);
    expect(await screen.findByRole('dialog', { name: 'elowen' })).toBeInTheDocument();
  });

  it('stacks at most three faces, counts the rest and names everyone in the tip', async () => {
    server.use(summaryOf({
      total: 5,
      samples: [
        { id: 2, username: 'bob', name: 'Bob Novak', avatar: '' },
        { id: 3, username: 'ada', name: 'Ada Křížová', avatar: '' },
        { id: 4, username: 'cleo', name: '', avatar: '' },
        { id: 5, username: 'dan', name: 'Dan Fischer', avatar: '' },
      ],
    }));
    mount();
    const stack = await screen.findByRole('button', { name: '5 assigned users' });
    expect(stack).toHaveAttribute('data-project-team', 'stack');
    expect(stack.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
    expect(within(stack).getByText('+2')).toBeInTheDocument();
    // Deterministic monogram initials from the shared avatar: one per word, two letters for a bare
    // username, and a non-ASCII name buckets like any other.
    expect(within(stack).getByText('BN')).toBeInTheDocument();
    expect(within(stack).getByText('AK')).toBeInTheDocument();
    expect(within(stack).getByText('CL')).toBeInTheDocument();

    fireEvent.click(stack);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Bob Novak')).toBeInTheDocument();
    expect(within(tip).getByText('@ada')).toBeInTheDocument();
    expect(within(tip).getByText('cleo')).toBeInTheDocument();
    expect(within(tip).getByText('2 more')).toBeInTheDocument();
  });

  // One control for the whole stack. A button per face inside a row that is itself openable is the
  // nested-interactive problem, and voice control would offer four unnamed targets for one fact.
  it('offers the team as a single control rather than one per face', async () => {
    server.use(summaryOf({ total: 2, samples: [
      { id: 2, username: 'bob', name: 'Bob Novak', avatar: '' },
      { id: 3, username: 'ada', name: 'Ada Křížová', avatar: '' },
    ] }));
    mount();
    const stack = await screen.findByRole('button', { name: '2 assigned users' });
    expect(within(stack).queryAllByRole('button')).toHaveLength(0);
    expect(within(stack).queryByText('+0')).toBeNull();
    expect(stack.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
  });

  // An empty team IS an answer and gets the quiet one. A membership that was never SERVED is not: the
  // daemon withholds it from non-administrators, and "no one assigned" would be this client guessing.
  it('states an empty team quietly and says nothing when membership was withheld', async () => {
    server.use(summaryOf({ total: 0, samples: [] }));
    mount();
    await screen.findByText('elowen');
    await waitFor(() => expect(document.querySelector('[data-project-team="empty"]')).not.toBeNull());
    expect(screen.getByText('No one assigned')).toHaveClass('sr-only');
    expect(screen.queryByRole('button', { name: /assigned users/ })).toBeNull();

    server.resetHandlers();
    server.use(http.get('*/api/projects/summary', () => HttpResponse.json([{ projectId: 1, indicators: [] }])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('elowen').length).toBeGreaterThan(1));
    expect(document.querySelectorAll('[data-project-team]')).toHaveLength(1);
  });

  // Removing the pill from the register removed a presentation, not a feature: `/projects/summary`
  // still serves the indicator and the plugins that own those connections still report them.
  it('renders no plugin indicator pill in a row, while the summary still carries one', async () => {
    let served = 0;
    server.use(http.get('*/api/projects/summary', () => {
      served += 1;
      return HttpResponse.json([{ projectId: 1, members: { total: 0, samples: [] }, indicators: [{ plugin: 'github', label: 'GitHub', value: '@dragocz', icon: 'Github', tone: 'success' }] }]);
    }));
    mount();
    await screen.findByText('elowen');
    await waitFor(() => expect(served).toBeGreaterThan(0));

    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText('@dragocz')).toBeNull();
  });
});
