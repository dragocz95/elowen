import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

/** A register card's identity band and its team strip.
 *
 *  Both replaced columns of their own. The Path column spent a third of the register's width on
 *  monospaced strings that read the same at a glance, and the Summary column repeated one plugin pill
 *  per card; what is left is the project, who works on it, what it is using, and one quiet mark holding
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
    // Nothing of the path is on the card until it is asked for. The identity line falls back to the path
    // only when the project has no notes, and this one does not — so it must be the card's own
    // description rather than a second copy of the exact string the tip holds.
    const card = mark.closest('[data-project-card]') as HTMLElement;
    expect(card.querySelector('[data-project-card-open]')).not.toBeNull();

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
    const card = mark.closest('[data-project-card]') as HTMLElement;
    expect(card.textContent).not.toContain('/analysis');
    // The runtime pill is the short word; the full phrase stays behind its title.
    expect(card.querySelector('[data-project-runtime="managed"]')).toHaveTextContent('Managed');

    fireEvent.click(mark);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Directory inside the environment')).toBeInTheDocument();
    expect(within(tip).getByText('/analysis')).toBeInTheDocument();
    expect(within(tip).getByText('Converted from')).toBeInTheDocument();
    expect(within(tip).getByText('/srv/legacy-analysis')).toBeInTheDocument();
  });

  // The mark sits inside a card whose quiet surface opens the project. It has to take its own click,
  // keep its own focus ring, and never open the project by accident.
  it('keeps the location mark reachable by keyboard without opening the card', async () => {
    mount();
    const mark = await screen.findByRole('button', { name: 'Host directory of elowen' });
    expect(mark.closest('[data-project-card]')).not.toHaveAttribute('data-selected');

    fireEvent.focus(mark);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(mark);
    // Still a tip, still no drawer: the card's own click handler did not receive the activation.
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();
    expect(mark.closest('[data-project-card]')).not.toHaveAttribute('data-selected');
  });

  it('opens from the quiet card surface while its nested controls keep their own clicks', async () => {
    server.use(summaryOf({ total: 2, samples: [
      { id: 2, username: 'bob', name: 'Bob Novak', avatar: '' },
      { id: 3, username: 'ada', name: 'Ada Křížová', avatar: '' },
    ] }));
    mount();
    const location = await screen.findByRole('button', { name: 'Host directory of elowen' });
    const card = location.closest('[data-project-card]') as HTMLElement;
    const projectName = within(card).getByRole('heading', { name: 'elowen' });
    const team = within(card).getByRole('button', { name: '2 assigned users' });

    // Every nested control stops its own activation: a count that opens a tip, a strip that pages faces
    // and a menu that offers actions must none of them read as a click on the card.
    fireEvent.click(team);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();

    fireEvent.click(card.querySelector('[data-project-team="strip"]')!);
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'elowen: Actions' }));
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(projectName);
    expect(await screen.findByRole('dialog', { name: 'elowen' })).toBeInTheDocument();
  });

  // The strip shows every face the daemon served and the control beside it carries the authoritative
  // headcount, so a team larger than the sample still states its real size.
  it('shows every served face in the strip and counts the whole team beside it', async () => {
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
    const detail = await screen.findByRole('button', { name: '5 assigned users' });
    expect(detail).toHaveAttribute('data-project-team', 'detail');
    expect(detail).toHaveTextContent('5');
    const strip = detail.closest('[data-project-card]')!.querySelector('[data-project-team="strip"]')!;
    expect(strip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(4);
    // Deterministic monogram initials from the shared avatar: one per word, two letters for a bare
    // username, and a non-ASCII name buckets like any other.
    expect(within(strip as HTMLElement).getByText('BN')).toBeInTheDocument();
    expect(within(strip as HTMLElement).getByText('AK')).toBeInTheDocument();
    expect(within(strip as HTMLElement).getByText('CL')).toBeInTheDocument();

    fireEvent.click(detail);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Bob Novak')).toBeInTheDocument();
    expect(within(tip).getByText('@ada')).toBeInTheDocument();
    expect(within(tip).getByText('cleo')).toBeInTheDocument();
    expect(within(tip).getByText('1 more')).toBeInTheDocument();
  });

  // One control for the whole team. A button per face inside a card that is itself openable is the
  // nested-interactive problem, and voice control would offer four unnamed targets for one fact. The
  // strip is a scroll region rather than a control, so it contributes no target at all.
  it('offers the team as a single control rather than one per face', async () => {
    server.use(summaryOf({ total: 2, samples: [
      { id: 2, username: 'bob', name: 'Bob Novak', avatar: '' },
      { id: 3, username: 'ada', name: 'Ada Křížová', avatar: '' },
    ] }));
    mount();
    const detail = await screen.findByRole('button', { name: '2 assigned users' });
    const strip = detail.closest('[data-project-card]')!.querySelector('[data-project-team="strip"]') as HTMLElement;
    expect(within(strip).queryAllByRole('button')).toHaveLength(0);
    expect(strip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
    expect(detail).toHaveTextContent('2');
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
