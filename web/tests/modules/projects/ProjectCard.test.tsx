import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ProjectsView } from '../../../modules/projects/ProjectsView';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

/** The register card's own three additions: the repository slot, the honest state of a project with no
 *  container, and the team strip.
 *
 *  The strip is the part with real behaviour behind it. `overflow-x: auto` answers touch, trackpad and
 *  the arrow keys of a focused region by itself; what the component adds is only what a mouse has no
 *  gesture for — a wheel over the strip and a pointer resting near an end — and every one of those
 *  additions has to stay out of the way of the register around it. */

const host = { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: 'Personal agent', icon: '' };
const managed = { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed', guestRoot: '/analysis' };

const team = (count: number) => ({
  total: count,
  samples: Array.from({ length: Math.min(count, 8) }, (_, index) => ({
    id: index + 2, username: `member${index}`, name: `Member ${index}`, avatar: '',
  })),
});

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json([host, managed])),
  http.get('*/api/projects/summary', () => HttpResponse.json([])),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/projects/:id/git', () => HttpResponse.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] })),
);

/** The strip's rendered width, which jsdom has no layout to produce. Only the strip is measured — every
 *  other element keeps the zero jsdom already reports. */
const geometry = { scrollWidth: 0, clientWidth: 0 };
/** jsdom accepts a `scrollLeft` write and discards it, because nothing here scrolls. Backing it makes
 *  the component's own clamping observable, which is the behaviour under test. */
const scrollPositions = new WeakMap<HTMLElement, number>();
const isStrip = (element: HTMLElement) => element.dataset.projectTeam === 'strip';

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** Run every frame currently queued, once. A drift that keeps re-arming therefore has to be pumped
 *  deliberately, which is how "it stops at the edge" can be told from "it never stops". */
const pumpFrames = () => {
  const due = [...frames];
  frames = new Map();
  for (const [, callback] of due) callback(performance.now());
  return due.length;
};

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) { return isStrip(this) ? geometry.scrollWidth : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return isStrip(this) ? geometry.clientWidth : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: HTMLElement) { return scrollPositions.get(this) ?? 0; },
    set(this: HTMLElement, value: number) { scrollPositions.set(this, value); },
  });
});
afterAll(() => {
  server.close();
  // Defined on HTMLElement.prototype, which only SHADOWS jsdom's own on Element.prototype; deleting
  // hands every other suite back the real implementations.
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollLeft');
});
beforeEach(() => {
  geometry.scrollWidth = 0;
  geometry.clientWidth = 0;
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
};
const summaryOf = (...entries: Record<string, unknown>[]) =>
  http.get('*/api/projects/summary', () => HttpResponse.json(entries));

const stripOf = async (slug: string): Promise<HTMLElement> => {
  const open = await screen.findByRole('button', { name: `Open project ${slug}` });
  const strip = open.closest('[data-project-card]')!.querySelector('[data-project-team="strip"]');
  if (!strip) throw new Error(`no team strip on ${slug}`);
  return strip as HTMLElement;
};

describe('project card: repository and container state', () => {
  // The branch comes from the register's own bounded projection, whichever way the project runs: a host
  // worktree is read from `.git/HEAD`, a managed one through its environment provider. The card does not
  // know the difference and must not: it draws the branch it was served.
  it('shows the branch the register projection served, for a host and a managed project alike', async () => {
    server.use(summaryOf(
      { projectId: 1, members: { total: 0, samples: [] }, branch: 'feat/cards', indicators: [] },
      { projectId: 3, members: { total: 0, samples: [] }, branch: 'release/2.0', indicators: [] },
    ));
    mount();

    const hostCard = (await screen.findByRole('button', { name: 'Open project elowen' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(hostCard.querySelector('[data-project-branch]')).not.toBeNull());
    expect(within(hostCard).getByText('feat/cards')).toBeInTheDocument();
    expect(hostCard.querySelector('[data-project-branch]')!.getAttribute('title')).toBe('Checked-out branch: feat/cards');

    const managedCard = screen.getByRole('button', { name: 'Open project analysis' }).closest('[data-project-card]') as HTMLElement;
    expect(within(managedCard).getByText('release/2.0')).toBeInTheDocument();
    expect(managedCard.querySelector('[data-project-branch]')!.getAttribute('title')).toBe('Checked-out branch: release/2.0');
  });

  // Absent is absent. A project whose branch the daemon could not determine — a cold container, a
  // directory that is not a repository, a provider that is not there — carries no branch slot at all;
  // an empty one would read as a repository with nothing checked out.
  it('draws no branch slot for a project the projection reported none for', async () => {
    server.use(summaryOf(
      { projectId: 1, members: { total: 0, samples: [] }, indicators: [] },
      { projectId: 3, members: { total: 0, samples: [] }, indicators: [] },
    ));
    mount();
    const hostCard = (await screen.findByRole('button', { name: 'Open project elowen' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(hostCard.querySelector('[data-project-card-open]')).not.toBeNull());

    expect(hostCard.querySelector('[data-project-branch]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open project analysis' }).closest('[data-project-card]')!.querySelector('[data-project-branch]')).toBeNull();
    expect(document.querySelectorAll('[data-project-branch]')).toHaveLength(0);
  });

  // A host project has no container, so there is nothing to measure. Three zeroed meters would be a
  // fabricated reading rather than a quiet one, so the card says what the project IS instead.
  it('states the host project plainly instead of inventing CPU, RAM and disk figures', async () => {
    mount();
    const hostCard = (await screen.findByRole('button', { name: 'Open project elowen' })).closest('[data-project-card]') as HTMLElement;

    expect(hostCard.querySelector('[data-project-host-state]')).not.toBeNull();
    expect(within(hostCard).getByText('Host project')).toBeInTheDocument();
    expect(within(hostCard).getByText('Runs in its host directory, without a container of its own.')).toBeInTheDocument();
    expect(hostCard.querySelector('[data-project-row-metrics]')).toBeNull();
    expect(within(hostCard).queryByRole('progressbar')).toBeNull();
    expect(hostCard.querySelector('[data-project-runtime]')).toHaveTextContent('Host');
    expect(hostCard.textContent).not.toContain('0%');

    // A managed project with no contributing plugin reports nothing at all rather than borrowing the
    // host wording: its environment is the sandbox plugin's to describe, and the plugin is absent here.
    const managedCard = screen.getByRole('button', { name: 'Open project analysis' }).closest('[data-project-card]') as HTMLElement;
    expect(managedCard.querySelector('[data-project-host-state]')).toBeNull();
    expect(managedCard.querySelector('[data-project-row-metrics]')).toBeNull();
  });

  // The card leads with what the project is for. Notes first, because somebody wrote that sentence about
  // it; the location only when there are none. Never an invented tagline.
  it('describes a project by its notes, falling back to where it runs', async () => {
    mount();
    const hostCard = (await screen.findByRole('button', { name: 'Open project elowen' })).closest('[data-project-card]') as HTMLElement;
    expect(within(hostCard).getByText('Personal agent')).toBeInTheDocument();

    const managedCard = screen.getByRole('button', { name: 'Open project analysis' }).closest('[data-project-card]') as HTMLElement;
    expect(within(managedCard).getByText('Managed environment')).toBeInTheDocument();
  });
});

describe('project card: team strip', () => {
  // A tab stop per card that scrolls nothing would put three inert targets between the reader and the
  // next project, so the strip becomes a region only when there is something in it to reach.
  it('is neither a region nor a tab stop while every face already fits', async () => {
    server.use(summaryOf({ projectId: 1, members: team(3), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3));

    expect(strip).not.toHaveAttribute('tabindex');
    expect(strip.getAttribute('role')).toBeNull();
    expect(strip).not.toHaveAttribute('data-project-team-overflow');
    expect(screen.queryByRole('group', { name: 'Assigned users of elowen' })).toBeNull();
  });

  it('becomes a focusable named scroll region once the faces overflow it', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));

    expect(strip).toHaveAttribute('role', 'group');
    expect(strip).toHaveAttribute('aria-label', 'Assigned users of elowen');
    expect(strip).toHaveAttribute('data-project-team-overflow', 'true');
    // Every face the daemon served is reachable; the count beside the strip stays the authoritative
    // headcount rather than the sample size.
    expect(strip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(8);
    expect(screen.getByRole('button', { name: '9 assigned users' })).toHaveTextContent('9');
  });

  it('pages the strip with the arrow keys and clamps at both ends', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));

    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(strip.scrollLeft).toBe(56);
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(strip.scrollLeft).toBe(0);
    // Already at the start: a second press cannot take it negative.
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(strip.scrollLeft).toBe(0);

    fireEvent.keyDown(strip, { key: 'End' });
    expect(strip.scrollLeft).toBe(280);
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(strip.scrollLeft).toBe(280);
    fireEvent.keyDown(strip, { key: 'Home' });
    expect(strip.scrollLeft).toBe(0);
  });

  // The register's own roving navigation lives on the card. A reader paging through faces is not asking
  // to move to the next project — and a key the strip does NOT consume must still reach that navigation.
  it('keeps its own arrows from moving the register, and lets every other key through', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));
    const card = strip.closest('[data-project-card]') as HTMLElement;

    // Consumed by the strip: the faces move and the register's selection does not.
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    fireEvent.keyDown(strip, { key: 'Home' });
    expect(card).not.toHaveAttribute('data-selected');
    expect(document.querySelector('[data-project-card][data-selected]')).toBeNull();

    // Not consumed: it reaches the card and moves the register to the next project.
    fireEvent.keyDown(strip, { key: 'ArrowDown' });
    await waitFor(() => expect(document.querySelector('[data-project-card="3"]')).toHaveAttribute('data-selected', 'true'));
  });

  it('turns a wheel over the strip into horizontal travel, and yields at the end', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));

    const consumed = new WheelEvent('wheel', { deltaY: 90, bubbles: true, cancelable: true });
    strip.dispatchEvent(consumed);
    expect(strip.scrollLeft).toBe(90);
    expect(consumed.defaultPrevented).toBe(true);

    // At the far end the strip has nothing left to give, so the page keeps its own scroll. Taking the
    // event there is exactly how a strip becomes a trap under a resting pointer.
    strip.scrollLeft = 280;
    const passed = new WheelEvent('wheel', { deltaY: 90, bubbles: true, cancelable: true });
    strip.dispatchEvent(passed);
    expect(strip.scrollLeft).toBe(280);
    expect(passed.defaultPrevented).toBe(false);
  });

  it('drifts while a mouse rests at an edge, stops when it leaves, and ends at the edge', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 120, width: 120 } as DOMRect);

    // Middle of the strip: nothing moves, and nothing is scheduled.
    fireEvent.pointerMove(strip, { pointerType: 'mouse', clientX: 60 });
    expect(frames.size).toBe(0);

    fireEvent.pointerMove(strip, { pointerType: 'mouse', clientX: 110 });
    expect(frames.size).toBe(1);
    pumpFrames();
    expect(strip.scrollLeft).toBe(5);
    pumpFrames();
    expect(strip.scrollLeft).toBe(10);

    // The pointer leaving cancels the loop rather than leaving a frame callback alive on a card that can
    // be filtered out from under it.
    fireEvent.pointerLeave(strip);
    expect(frames.size).toBe(0);
    expect(strip.scrollLeft).toBe(10);

    // Resting at the end drifts up to the limit and then STOPS: no perpetual animation against a value
    // that can no longer change.
    strip.scrollLeft = 277;
    fireEvent.pointerMove(strip, { pointerType: 'mouse', clientX: 118 });
    pumpFrames();
    expect(strip.scrollLeft).toBe(280);
    pumpFrames();
    expect(strip.scrollLeft).toBe(280);
    expect(frames.size).toBe(0);
  });

  // Touch drags the strip directly and a pen has no hover: neither needs — or gets — the drift.
  it('drifts only under a mouse', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 120, width: 120 } as DOMRect);

    fireEvent.pointerMove(strip, { pointerType: 'touch', clientX: 118 });
    fireEvent.pointerMove(strip, { pointerType: 'pen', clientX: 118 });
    expect(frames.size).toBe(0);
    expect(strip.scrollLeft).toBe(0);
  });

  // A reduced-motion preference removes the AMBIENT drift and nothing else: the wheel and the arrow
  // keys, the two deliberate gestures, still reach every face. Losing those would leave the strip with
  // content nobody could get to.
  it('drops the drift for a reader who asked for less motion, keeping wheel and keyboard', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    } as MediaQueryList));
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-effects', 'reduced'));
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 120, width: 120 } as DOMRect);

    fireEvent.pointerMove(strip, { pointerType: 'mouse', clientX: 118 });
    expect(frames.size).toBe(0);
    expect(strip.scrollLeft).toBe(0);

    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(strip.scrollLeft).toBe(56);
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(96);
  });

  // The strip sits inside a card whose quiet surface opens the project. Paging faces is not opening it.
  it('does not open the project when the strip itself is used', async () => {
    geometry.scrollWidth = 400;
    geometry.clientWidth = 120;
    server.use(summaryOf({ projectId: 1, members: team(9), indicators: [] }));
    mount();
    const strip = await stripOf('elowen');
    await waitFor(() => expect(strip).toHaveAttribute('tabindex', '0'));

    fireEvent.click(strip);
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(screen.queryByRole('dialog', { name: 'elowen' })).toBeNull();
    expect(strip.closest('[data-project-card]')).not.toHaveAttribute('data-selected');
  });
});
