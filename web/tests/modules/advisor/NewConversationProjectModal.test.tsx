import { describe, expect, it, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import type { ProjectExecutionRef } from '../../../lib/types';

/** The question a brand-new conversation is asked, before the first message is written.
 *
 *  What it pins: the reachable projects are the destinations, the target the daemon already chose is
 *  preselected, arrows walk the cards, only an administrator is offered the host with no project behind
 *  it, and a choice travels the same authorized execution endpoint the chat's project picker uses. */

const viewport = vi.hoisted(() => ({ mobile: false as boolean | undefined }));
const chat = vi.hoisted(() => {
  const closeProjectChoice = vi.fn();
  return {
    closeProjectChoice,
    value: {
      projectChoiceOpen: true,
      closeProjectChoice,
      telemetry: { projectRef: null as ProjectExecutionRef | null },
      activeSessionId: 'brain-1-a' as string | null,
    },
  };
});
vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => chat.value }));
vi.mock('../../../lib/useMobile', () => ({
  useMobileViewport: () => viewport.mobile,
  useIsMobile: () => viewport.mobile === true,
}));
const { NewConversationProjectModal } = await import('../../../modules/advisor/NewConversationProjectModal');

const PROJECTS = [
  { id: 1, slug: 'kolin', path: '/workspace', executionKind: 'managed' },
  { id: 2, slug: 'elowen', path: '/workspace', executionKind: 'managed' },
  { id: 3, slug: 'server', path: '/host', executionKind: 'host' },
];
const admin = { value: false };
const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(PROJECTS)),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, is_admin: admin.value } })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
beforeEach(() => {
  admin.value = false;
  viewport.mobile = false;
  chat.value.projectChoiceOpen = true;
  chat.value.telemetry.projectRef = null;
  chat.value.activeSessionId = 'brain-1-a';
  chat.closeProjectChoice.mockClear();
});
afterEach(() => server.resetHandlers());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><NewConversationProjectModal /></ToastProvider></Wrapper>);
};
const cards = () => screen.getAllByRole('radio');
const cardOf = (name: string | RegExp) => screen.getByRole('radio', { name });

describe('NewConversationProjectModal', () => {
  it('stays closed while no fresh conversation is waiting for an answer', () => {
    chat.value.projectChoiceOpen = false;
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Every project the API offered this account, named the way it is named everywhere else, with the
  // execution kind said beside it. `GET /projects` is already authorization-filtered.
  it('offers the reachable projects with their execution kind', async () => {
    mount();
    await screen.findByRole('radio', { name: /kolin/ });
    expect(cards().map((card) => card.textContent)).toEqual([
      'kolinManaged environment',
      'elowenManaged environment',
      'serverHost directory',
    ]);
  });

  it('preselects the target the daemon already chose for the conversation', async () => {
    chat.value.telemetry.projectRef = { kind: 'managed', projectId: 2 };
    mount();
    const preselected = await screen.findByRole('radio', { name: /elowen/ });
    expect(preselected).toHaveAttribute('aria-checked', 'true');
    expect(preselected).toHaveAttribute('tabindex', '0');
    expect(cardOf(/kolin/)).toHaveAttribute('aria-checked', 'false');
    expect(cardOf(/kolin/)).toHaveAttribute('tabindex', '-1');
  });

  // Nothing is reported for a conversation whose status has not landed yet; the first destination is
  // then the one under the hand, so the dialog is never in a state where Enter means nothing.
  it('falls back to the first destination when no target is reported', async () => {
    mount();
    await waitFor(() => expect(cardOf(/kolin/)).toHaveAttribute('aria-checked', 'true'));
  });

  it('walks the cards with the arrow keys and wraps at both ends', async () => {
    mount();
    const list = await screen.findByTestId('new-conversation-projects');
    await waitFor(() => expect(cardOf(/kolin/)).toHaveAttribute('aria-checked', 'true'));

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(cardOf(/elowen/)).toHaveAttribute('aria-checked', 'true');
    expect(cardOf(/elowen/)).toHaveFocus();

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(cardOf(/server/)).toHaveAttribute('aria-checked', 'true');
    // Past the last card the selection wraps rather than dying at the edge.
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(cardOf(/kolin/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(cardOf(/server/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(cardOf(/kolin/)).toHaveAttribute('aria-checked', 'true');
  });

  // An administrator with no project chosen keeps the whole host, which is what their conversations did
  // before project environments existed. A non-administrator always lands in a project.
  it('offers the nameless host only to an administrator', async () => {
    mount();
    await screen.findByRole('radio', { name: /kolin/ });
    expect(screen.queryByRole('radio', { name: /Continue without a project/i })).toBeNull();

    admin.value = true;
    mount();
    expect(await screen.findByRole('radio', { name: /Continue without a project/i })).toBeInTheDocument();
  });

  it('sends the chosen project on the fresh conversation and closes', async () => {
    let body: unknown;
    server.use(http.post('*/api/brain/execution', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ projectRef: { kind: 'managed', projectId: 2 }, workDir: '/workspace' });
    }));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /elowen/ }));
    await waitFor(() => expect(body).toEqual({ target: { kind: 'managed', projectId: 2 }, session: 'brain-1-a' }));
    await waitFor(() => expect(chat.closeProjectChoice).toHaveBeenCalledTimes(1));
  });

  it('sends a host project by its identity and the administrator host with none', async () => {
    admin.value = true;
    const bodies: unknown[] = [];
    server.use(http.post('*/api/brain/execution', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ projectRef: { kind: 'host' }, workDir: '/' });
    }));
    const first = mount();
    fireEvent.click(await screen.findByRole('radio', { name: /server/ }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    first.unmount();

    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Continue without a project/i }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies).toEqual([
      { target: { kind: 'host', projectId: 3 }, session: 'brain-1-a' },
      { target: { kind: 'host' }, session: 'brain-1-a' },
    ]);
  });

  // A refused selection leaves the dialog open with the failure said out loud: the conversation still
  // runs where the daemon put it, and the person can pick again.
  it('keeps the dialog open and reports a refused selection', async () => {
    server.use(http.post('*/api/brain/execution', () => HttpResponse.json({ error: 'conversation still has active work' }, { status: 409 })));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /elowen/ }));
    expect(await screen.findByText(/conversation still has active work/)).toBeInTheDocument();
    expect(chat.closeProjectChoice).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // A phone reads the destinations as a list down the screen and takes the whole viewport; anywhere with
  // room they sit side by side in a centered window.
  it('takes the whole screen and stacks the destinations on a phone', async () => {
    viewport.mobile = true;
    mount();
    const list = await screen.findByTestId('new-conversation-projects');
    expect(list.className).toMatch(/flex-col/);
    expect(list.className).toMatch(/sm:flex-row/);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'fullscreen');
  });
});
