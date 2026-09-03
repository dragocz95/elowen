import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';

// The picker reads the live conversation off the chat controller. Standing that in keeps these cases
// about the control's own behaviour instead of about wiring up a whole chat session.
const chat = { telemetry: { project: null as { cwd: string } | null }, activeSessionId: null as string | null };
vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => chat }));

const { ProjectPicker, projectForPath } = await import('../../../modules/advisor/ProjectPicker');

const project = (id: number, slug: string, path: string) => ({ id, slug, path });

describe('projectForPath', () => {
  it('matches the directory itself and anything under it', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/var/www/kolin')?.slug).toBe('kolin');
    expect(projectForPath(projects, '/var/www/kolin/src/api')?.slug).toBe('kolin');
  });

  it('does not mistake a sibling whose name merely starts the same', () => {
    // '/var/www/kolin-worktrees'.startsWith('/var/www/kolin') is true as a string and false as a
    // directory. Naming the wrong project would be worse than naming none, so the boundary is the
    // separator, not the prefix.
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/var/www/kolin-worktrees')).toBeNull();
    expect(projectForPath(projects, '/var/www/kolinx/src')).toBeNull();
  });

  it('picks the innermost project when registrations nest', () => {
    // A monorepo registered alongside one of its packages: both contain the directory, and the answer
    // the user means is the closer one.
    const projects = [project(1, 'mono', '/repo'), project(2, 'pkg', '/repo/packages/ui')];
    expect(projectForPath(projects, '/repo/packages/ui/src')?.slug).toBe('pkg');
    expect(projectForPath(projects, '/repo/packages/api')?.slug).toBe('mono');
  });

  it('is insensitive to a trailing slash on the registered path', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin/')];
    expect(projectForPath(projects, '/var/www/kolin')?.slug).toBe('kolin');
    expect(projectForPath(projects, '/var/www/kolin/src')?.slug).toBe('kolin');
  });

  it('reports nothing rather than guessing when the directory is unknown or absent', () => {
    const projects = [project(1, 'kolin', '/var/www/kolin')];
    expect(projectForPath(projects, '/tmp/scratch')).toBeNull();
    expect(projectForPath(projects, null)).toBeNull();
    expect(projectForPath(projects, undefined)).toBeNull();
    expect(projectForPath(projects, '')).toBeNull();
    // An empty registered path would otherwise contain every directory on the machine.
    expect(projectForPath([project(1, 'broken', '')], '/var/www/kolin')).toBeNull();
  });
});

const PROJECTS = [project(1, 'kolin', '/var/www/kolin'), project(2, 'elowen', '/var/www/elowen')];

const server = setupServer(http.get('*/api/projects', () => HttpResponse.json(PROJECTS)));
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  chat.telemetry.project = null;
  chat.activeSessionId = null;
});

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><ProjectPicker /></ToastProvider></Wrapper>);
};

describe('ProjectPicker', () => {
  it('stays disabled until a conversation is live', async () => {
    // `/brain/cwd` resolves the caller's ACTIVE session and answers 409 "brain not started" when there is
    // none — exactly the state a freshly opened chat is in before its first turn. Offering the control
    // there would hand the user an error for doing what the interface invited them to do.
    mount();
    const button = await screen.findByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('shows the directory the daemon confirmed, without waiting for a session event', async () => {
    // The status poll that would otherwise refresh this label is driven by a session event, and session
    // events are SUPPRESSED for a conversation with no messages yet. So in a brand-new chat — the case
    // where somebody is most likely to set the project first — the move would succeed while the label
    // went on reading "no project", making a working feature look broken.
    chat.activeSessionId = 'brain-1-a';
    let asked: unknown = null;
    server.use(http.post('*/api/brain/cwd', async ({ request }) => {
      asked = await request.json();
      return HttpResponse.json({ workDir: '/var/www/kolin' });
    }));

    mount();
    const trigger = await screen.findByRole('button');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const option = await screen.findByRole('menuitemradio', { name: /kolin/ });
    await waitFor(() => expect(option).toHaveFocus());
    fireEvent.keyDown(option, { key: 'Enter' });

    await waitFor(() => expect(asked).toEqual({ dir: '/var/www/kolin', session: 'brain-1-a' }));
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('kolin'));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
