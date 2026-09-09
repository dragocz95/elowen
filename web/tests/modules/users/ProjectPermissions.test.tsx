import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { managedProjectStrings } from '../../../modules/projects/managedProjectStrings';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { User } from '../../../lib/types';

const updateUser = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useUpdateUser: () => ({ mutate: updateUser, mutateAsync: updateUser, isPending: false }),
}));

import { ProjectPermissions } from '../../../modules/users/ProjectPermissions';

const s = managedProjectStrings.en;

const user = (over: Partial<User> = {}): User => ({
  id: 2, username: 'bob', name: '', email: '', avatar: '', created_at: '2026-01-02', is_admin: false,
  allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [], default_exec: '', advisor_exec: '',
  advisor_autostart: false, can_create_projects: false, can_share_projects: false, project_limit: 3, ...over,
});

function mount(u: User = user()) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><ProjectPermissions user={u} /></ToastProvider></Wrapper>);
}

/** The patch bodies of every PATCH the component asked for, in order. */
const patches = (): unknown[] => updateUser.mock.calls.map((call) => (call[0] as { patch: unknown }).patch);

beforeEach(() => {
  updateUser.mockReset();
  updateUser.mockResolvedValue({});
});

describe('ProjectPermissions — records that persist themselves', () => {
  // The section used to be a FORM: two stacked label-above-switch fields, a full-width number input and a
  // "Save project permissions" button. Every other account control in the app persists on change, so the
  // button was the odd one out — and a settings surface with one explicit save teaches that the others
  // might not have saved.
  it('offers no save button', () => {
    mount();
    // The retired label is spelled out rather than read from the dictionary: the string itself is gone,
    // and this case is what keeps it from coming back.
    expect(screen.queryByRole('button', { name: 'Save project permissions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('lays each permission out as one label/control record rather than a stacked field', () => {
    const { container } = mount();
    const rows = container.querySelectorAll('.settings-row');
    expect(rows).toHaveLength(3);
    for (const label of [s.createGrant, s.shareGrant, s.limit]) {
      const row = screen.getByText(label).closest('.settings-row');
      expect(row, `${label} is not a record`).not.toBeNull();
      // The control sits in the record's trailing cell, opposite its label — not underneath it.
      expect(row!.querySelector('.settings-row__control')).not.toBeNull();
    }
  });

  it('does not write anything while it is only seeding from the server', async () => {
    mount(user({ can_create_projects: true, project_limit: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('persists a grant on change, patching ONLY that field', async () => {
    mount();
    fireEvent.click(screen.getByRole('switch', { name: s.createGrant }));
    await waitFor(() => expect(updateUser).toHaveBeenCalled(), { timeout: 1500 });
    expect(updateUser.mock.calls[0]![0]).toEqual({ id: 2, patch: { can_create_projects: true } });
  });

  it('persists the sharing grant independently of the creation grant', async () => {
    mount(user({ can_create_projects: true }));
    fireEvent.click(screen.getByRole('switch', { name: s.shareGrant }));
    await waitFor(() => expect(updateUser).toHaveBeenCalled(), { timeout: 1500 });
    // Only the field the admin touched travels: the route merges, so re-sending the others would let a
    // stale copy of this drawer overwrite a grant changed elsewhere.
    expect(patches()).toEqual([{ can_share_projects: true }]);
  });

  it('offers the limit as a slider bounded by what the route accepts, showing its current value', () => {
    mount(user({ project_limit: 7 }));
    // No number field remains — the old full-width input was the widest control on the page.
    expect(screen.queryByRole('spinbutton')).toBeNull();
    const slider = screen.getByRole('slider', { name: s.limit });
    expect(slider.getAttribute('aria-valuenow')).toBe('7');
    expect(slider.getAttribute('aria-valuemin')).toBe('1');
    expect(slider.getAttribute('aria-valuemax')).toBe('1000');
    // The reading is on screen, not only in the accessibility tree.
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('moves the limit by one integer per arrow key and persists only the limit', async () => {
    mount(user({ project_limit: 3 }));
    const slider = screen.getByRole('slider', { name: s.limit });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('4');
    await waitFor(() => expect(updateUser).toHaveBeenCalled(), { timeout: 2000 });
    expect(patches()).toEqual([{ project_limit: 4 }]);
  });

  // A drag is a burst of value changes. Each one must not become a request, and the value that lands on
  // the server has to be the one the admin stopped on.
  it('collapses a burst of limit changes into the value the admin ended on', async () => {
    mount(user({ project_limit: 3 }));
    const slider = screen.getByRole('slider', { name: s.limit });
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(updateUser).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(patches()).toEqual([{ project_limit: 8 }]);
  });

  // Closing the drawer is the ordinary way out of this section, and a slider edit is still inside its
  // debounce for most of a second. The shared controller flushes on teardown; this pins that the record
  // actually gets that behaviour, because dropping the write silently is indistinguishable from saving it.
  it('still persists a limit edit when the drawer closes inside the debounce', async () => {
    const { unmount } = mount(user({ project_limit: 3 }));
    fireEvent.keyDown(screen.getByRole('slider', { name: s.limit }), { key: 'ArrowRight' });
    expect(patches()).toEqual([]);
    unmount();
    await waitFor(() => expect(patches()).toEqual([{ project_limit: 4 }]), { timeout: 2000 });
  });

  // The reading used to sit in the record's STATUS, which an inline record renders on the LABEL's line.
  // Measured in the real drawer at a 390px viewport the Czech label already wrapped, so the number was
  // pushed onto a line of its own — further from the slider it names than from the record above it.
  it('reads the limit beside its slider rather than on the label line', () => {
    mount(user({ project_limit: 42 }));
    const row = screen.getByText(s.limit).closest('.settings-row')!;
    expect(row.querySelector('.settings-row__control')!.textContent).toContain('42');
    expect(row.querySelector('.settings-row__title')!.textContent).not.toContain('42');
  });

  it('reports a failed save and keeps the admin intent on screen instead of a silent success', async () => {
    updateUser.mockRejectedValueOnce(new Error('nope'));
    mount();
    fireEvent.click(screen.getByRole('switch', { name: s.shareGrant }));
    expect(await screen.findByText(en.common.saveFailed, {}, { timeout: 2000 })).toBeTruthy();
    // The switch still shows what the admin asked for, so Retry sends the intended value.
    expect(screen.getByRole('switch', { name: s.shareGrant }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: en.common.retry })).toBeTruthy();
  });
});
