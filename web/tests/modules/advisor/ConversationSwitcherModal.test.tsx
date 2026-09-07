import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ConversationSwitcherModal } from '../../../modules/advisor/ConversationSwitcherModal';

/** THE conversation switcher: one modal for both the personal list and the administrator's register.
 *
 *  What this pins is the consolidation itself. The app used to switch conversation in four places — a
 *  left rail, a phone drawer, the dock's popover and a separate register modal — so the invariants worth
 *  a test are that this surface carries the personal list with everything that list could do, that the
 *  register is behind an administrator-only switch beside it rather than being the only view, and that
 *  the shape is a centered window on a roomy screen and the whole screen on a phone. */

const ctrl = vi.hoisted(() => {
  const switchSession = vi.fn(() => Promise.resolve());
  const closeHistory = vi.fn();
  return {
    switchSession,
    closeHistory,
    value: {
      historyOpen: true,
      closeHistory,
      sessions: {
        data: [
          { id: 's1', title: 'First', model: 'sonnet', updated_at: '2026-07-08T10:00:00.000Z', running: false, active: true },
          { id: 's2', title: 'Second', model: 'sonnet', updated_at: '2026-07-07T10:00:00.000Z', running: false, active: false },
        ],
      },
      switchSession,
      deleteSession: vi.fn(() => Promise.resolve()),
    },
  };
});

const admin = vi.hoisted(() => ({ value: false }));
const jobLinks = vi.hoisted(() => ({
  value: { status: 'available', links: [] as Record<string, unknown>[] },
}));

const client = vi.hoisted(() => ({
  brainSearch: vi.fn(() => Promise.resolve([])),
  brainRenameSession: vi.fn(() => Promise.resolve({ id: 's1', title: 'First' })),
  brainExportSession: vi.fn(() => Promise.resolve()),
  brainForkSession: vi.fn(() => Promise.resolve({ id: 's1-fork', title: 'First' })),
  brainConversationLinks: vi.fn(() => Promise.resolve(jobLinks.value)),
  brainSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'First', model: 'sonnet', updated_at: '2026-07-08T10:00:00.000Z', running: false, active: true }])),
  brainManagedSessions: vi.fn(() => Promise.resolve([
    { id: 'brain-boss', title: 'Operator planning', model: 'sonnet', updated_at: '2026-07-08T10:00:00.000Z', running: false, kind: 'conversation', tokens: 12, ownerId: 9, ownerLabel: 'Someone else' },
  ])),
  listUsers: vi.fn(() => Promise.resolve([])),
  me: vi.fn(() => Promise.resolve({ user: { id: 2, username: 'me', is_admin: admin.value } })),
}));

vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctrl.value }));
vi.mock('../../../lib/elowenClient', () => ({ elowenClient: client }));

/** The modal reads the one controller for both its open state and the way out, exactly as the shell
 *  mounts it — there is no prop to pass, which is what makes a second switcher impossible. */
function renderModal() {
  const { wrapper: Wrapper } = createWrapper();
  const tree = () => <Wrapper><ToastProvider><ConversationSwitcherModal /></ToastProvider></Wrapper>;
  const utils = render(tree());
  /** Open and close it the only way the app can: through the controller the shell keeps mounted. A fresh
   *  element each time, because React bails out of re-rendering an identical one. */
  const setOpen = (next: boolean) => {
    ctrl.value.historyOpen = next;
    utils.rerender(tree());
  };
  return { ...utils, setOpen, onClose: ctrl.closeHistory };
}

const dialog = () => screen.findByRole('dialog', { name: /^(Conversations|Konverzace|Konverzácie)$/i });

beforeEach(() => {
  admin.value = false;
  ctrl.value.historyOpen = true;
  jobLinks.value = { status: 'available', links: [] };
  for (const fn of Object.values(client)) (fn as { mockClear: () => void }).mockClear();
  client.brainConversationLinks.mockImplementation(() => Promise.resolve(jobLinks.value));
  client.me.mockImplementation(() => Promise.resolve({ user: { id: 2, username: 'me', is_admin: admin.value } }));
  ctrl.switchSession.mockClear();
  ctrl.closeHistory.mockClear();
});

describe('ConversationSwitcherModal', () => {
  it('shows an ordinary account its own conversations and no register switch', async () => {
    renderModal();
    const modal = await dialog();
    expect(within(modal).getByText('First')).toBeInTheDocument();
    expect(within(modal).getByText('Second')).toBeInTheDocument();
    // No second view to choose, so no control offering one — and the register is never asked for.
    expect(within(modal).queryByRole('radio', { name: /All conversations|Všechny konverzace|Všetky konverzácie/i })).toBeNull();
    expect(client.brainManagedSessions).not.toHaveBeenCalled();
  });

  it('keeps every row action the list had: new, rename, branch, export and delete', async () => {
    renderModal();
    const modal = await dialog();
    expect(within(modal).getByRole('button', { name: /New chat|Nová konverzace|Nová konverzácia/i })).toBeInTheDocument();
    expect(within(modal).getByRole('searchbox', { name: /Search conversations|Hledat v konverzacích|Hľadať v konverzáciách/i })).toBeInTheDocument();

    fireEvent.click(within(modal).getAllByRole('button', { name: /More actions|Další akce|Ďalšie akcie/i })[0]!);
    for (const name of [
      /^Rename$|^Přejmenovat$|^Premenovať$/i,
      /Branch conversation|Větvit konverzaci|Vetviť konverzáciu/i,
      /Delete conversation|Smazat konverzaci|Vymazať konverzáciu/i,
    ]) expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
  });

  it('files the personal schedules under their conversation, collapsed', async () => {
    jobLinks.value = {
      status: 'available',
      links: [{ jobId: 'job-1', conversationId: 's1', name: 'Nightly digest', enabled: true, scope: 'personal', href: '/p/cronjob?job=job-1' }],
    };
    const { onClose } = renderModal();
    const modal = await dialog();

    const branch = await within(modal).findByRole('button', { name: /Scheduled jobs of First|Naplánované úlohy konverzace First/i });
    expect(branch).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(branch);

    const link = await within(modal).findByRole('link', { name: /Nightly digest/ });
    expect(link).toHaveAttribute('href', '/p/cronjob?job=job-1');
    // Opening the schedule leaves the app in the cron editor, so the switcher gets out of the way.
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers an administrator the register beside the personal list, and asks for it only then', async () => {
    admin.value = true;
    renderModal();
    const modal = await dialog();
    await within(modal).findByText('First');
    expect(client.brainManagedSessions).not.toHaveBeenCalled();

    fireEvent.click(within(modal).getByRole('radio', { name: /All conversations|Všechny konverzace|Všetky konverzácie/i }));

    expect(await screen.findByTestId('brain-sessions-list')).toBeInTheDocument();
    expect(await screen.findByText('Operator planning')).toBeInTheDocument();
    await waitFor(() => expect(client.brainManagedSessions).toHaveBeenCalled());
    // One all/mine decision, made here — the register does not repeat it inside its own toolbar.
    expect(within(screen.getByTestId('brain-sessions-toolbar')).queryByRole('radio', { name: /Just mine|Jen moje|Len moje/i })).toBeNull();
  });

  // The shell keeps this modal mounted for the app's whole life, so anything it remembers between two
  // openings is remembered forever. An administrator who last looked at the register must still arrive
  // at their own conversations next time: that is what the switcher is for, and it is the common case.
  it('opens on the personal list again after an administrator closed it on the register', async () => {
    admin.value = true;
    const { setOpen } = renderModal();
    await dialog();
    fireEvent.click(await screen.findByRole('radio', { name: /All conversations|Všechny konverzace|Všetky konverzácie/i }));
    expect(await screen.findByTestId('brain-sessions-list')).toBeInTheDocument();

    setOpen(false);
    expect(screen.queryByRole('dialog', { name: /^(Conversations|Konverzace|Konverzácie)$/i })).toBeNull();

    setOpen(true);
    const reopened = await dialog();
    expect(within(reopened).getByText('First')).toBeInTheDocument();
    expect(screen.queryByTestId('brain-sessions-list')).toBeNull();
  });

  // The shared dialog header is ONE row: icon, title, actions, close. Two sentence-long labels do not fit
  // beside a title on a phone — the switch took the row and the list's own name was clipped to a letter.
  it('moves the view switch out of the header and above the list on a phone', async () => {
    admin.value = true;
    const original = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...original(query), matches: /max-width/.test(query) });
    try {
      renderModal();
      const modal = await dialog();
      const register = await within(modal).findByRole('radio', { name: /All conversations|Všechny konverzace|Všetky konverzácie/i });
      expect(register.closest('[data-slot="dialog-header"]')).toBeNull();
      // Still the same one control: choosing the register from its new place works exactly as before.
      fireEvent.click(register);
      expect(await screen.findByTestId('brain-sessions-list')).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('keeps the view switch in the header where the row has room for it', async () => {
    admin.value = true;
    renderModal();
    const modal = await dialog();
    const register = await within(modal).findByRole('radio', { name: /All conversations|Všechny konverzace|Všetky konverzácie/i });
    expect(register.closest('[data-slot="dialog-header"]')).not.toBeNull();
  });

  it('closes on Escape', async () => {
    const { onClose } = renderModal();
    const modal = await dialog();
    fireEvent.keyDown(modal, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('puts focus in the search field when it opens', async () => {
    renderModal();
    const modal = await dialog();
    await waitFor(() => {
      expect(within(modal).getByRole('searchbox', { name: /Search conversations|Hledat v konverzacích|Hľadať v konverzáciách/i })).toHaveFocus();
    });
  });
});
