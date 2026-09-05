import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxModal } from '../../../modules/advisor/SandboxModal';

const createMutate = vi.fn();
const useMutate = vi.fn();
const previewMutate = vi.fn();
const removeMutate = vi.fn();
const releaseMutate = vi.fn();
const refetch = vi.fn();
const toast = vi.fn();

const workspace = (over: Record<string, unknown>) => ({
  id: 'ws_1',
  userId: 3,
  projectId: 1,
  label: 'Payments',
  path: '/data/u3/payments',
  branch: 'elowen/u3/payments',
  baseRef: 'main',
  lifecycle: 'active',
  orphanReason: null,
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  lastUsedAt: '2026-09-01',
  accessible: true,
  status: { branch: 'elowen/u3/payments', head: 'abc', upstream: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true },
  files: [],
  uniqueCommits: 0,
  activeProcesses: 0,
  bindings: [],
  ...over,
});

const overview = {
  // `defaultRef` is what the daemon read from the repository. The second project has none, which is the
  // case the form must not paper over with a guessed branch name.
  projects: [
    { id: 1, slug: 'kolin', path: '/var/www/kolin', defaultRef: 'main' },
    { id: 2, slug: 'elowen', path: '/var/www/elowen', defaultRef: null },
  ],
  sessions: [{ id: 'brain-7-a', title: 'Katalog', updatedAt: '2026-09-01' }],
  workspaces: [
    workspace({}),
    workspace({
      id: 'ws_2', projectId: 1, label: 'Checkout', branch: 'elowen/u3/checkout', baseRef: 'release',
      status: { branch: 'elowen/u3/checkout', head: 'def', upstream: null, ahead: 2, behind: 0, dirty: 3, untracked: 1, clean: false },
      uniqueCommits: 2, activeProcesses: 0, bindings: [{ sessionId: 'brain-7-a', updatedAt: '2026-09-02' }],
    }),
    workspace({ id: 'ws_3', projectId: 2, label: 'Docs', branch: 'elowen/u3/docs', lifecycle: 'orphaned', orphanReason: 'path_missing' }),
  ],
};

vi.mock('../../../lib/queries', () => ({
  useSandboxOverview: () => ({ data: overview, isLoading: false, isError: false, isFetching: false, refetch }),
}));
vi.mock('../../../lib/mutations', () => ({
  useCreateSandboxWorkspace: () => ({ mutate: createMutate, isPending: false }),
  useUseSandboxWorkspace: () => ({ mutate: useMutate, isPending: false }),
  useSandboxRemovalPreview: () => ({ mutate: previewMutate, isPending: false }),
  useRemoveSandboxWorkspace: () => ({ mutate: removeMutate, isPending: false }),
  useReleaseSandboxWorkspaces: () => ({ mutate: releaseMutate, isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
// `apiErrorMessage` reads the daemon's coded error off an ElowenApiError. The modal maps exactly those
// codes onto its blocked-removal sentences, so the stub answers a plain `code` field.
vi.mock('../../../lib/elowenClient', () => ({
  apiErrorMessage: (error: unknown) => (error as { code?: string }).code ?? 'unknown',
}));
vi.mock('../../../lib/i18n', () => ({
  interpolate: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (placeholder, key) => (key in values ? String(values[key]) : placeholder)),
  useTranslation: () => ({
    t: {
      sandboxModal: {
        modalTitle: 'Sandbox workspaces', refresh: 'Refresh',
        loadError: 'Overview unavailable', emptyTitle: 'No workspaces', emptyDesc: 'Nothing here.',
        create: 'New workspace', createSubmit: 'Create',
        project: 'Project', label: 'Name', labelPlaceholder: 'For example', baseRef: 'Base reference', baseRefPlaceholder: 'Branch',
        createHint: 'Creating does not move this conversation. Choose Use here to work there.',
        baseRefUnknown: 'This project states no default branch, so enter the reference to branch from.',
        activeHere: 'Active in this conversation', activeElsewhere: 'Active in another conversation',
        orphaned: 'Orphaned', clean: 'Clean',
        dirty: 'Modified files: {n}', untracked: 'Untracked files: {n}',
        ahead: 'Ahead: {n}', behind: 'Behind: {n}',
        uniqueCommits: 'Commits present nowhere else: {n}', processes: 'Running processes: {n}',
        use: 'Use here', useNoSession: 'Open a conversation first.',
        returnToProject: 'Return to project', returnPending: 'Returning',
        returnDescription: 'Only this conversation goes back to the project directory. The workspace is kept.',
        returned: 'Back in the project directory. The workspace has been kept.',
        returnNothing: 'Already in the project directory.',
        returnBlockedInUse: 'A running process is using the workspace; nothing has been changed.',
        returnFailed: 'Could not return to the project directory.',
        switched: 'Now working in {label}.', created: 'Created {label}.', removed: 'Removed {label}.',
        workspaceActions: 'Workspace actions', remove: 'Remove',
        removeTitle: 'Remove this workspace?', removePending: 'Removing',
        removeDescription: '{label} / {project} / {branch}',
        removePreviewError: 'Preview unavailable.',
        blockedInUse: 'A running process is using it; it was not removed.',
        blockedNotClean: 'It has uncommitted work; it was not removed.',
        blockedChanged: 'It changed since the summary; it was not removed.',
        blockedFallback: 'It could not be removed.',
      },
      common: { cancel: 'Cancel', delete: 'Delete', close: 'Close', error: 'Error', requiredField: 'required', loading: 'Loading', retry: 'Retry' },
    },
  }),
}));

const renderModal = () => render(<SandboxModal onClose={vi.fn()} activeSessionId="brain-7-a" />);

/** Open the ⋯ menu of one row and choose Remove, then answer the preview the drawer asks for. */
async function startRemoval(label: string, preview: Partial<Record<string, number>> = {}) {
  fireEvent.click(screen.getByRole('button', { name: `Workspace actions: ${label}` }));
  const menu = await screen.findByRole('menu');
  await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' })); });
  const onSuccess = previewMutate.mock.calls.at(-1)![1].onSuccess as (p: unknown) => void;
  await act(async () => {
    onSuccess({
      workspaceId: 'ws_2', head: 'def', dirty: 3, untracked: 1, uniqueCommits: 2, activeProcesses: 0, files: [], ...preview,
    });
  });
}

describe('SandboxModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the workspaces under their project with the state each one is in', () => {
    renderModal();

    // Grouped by project, so a row says which repository it was cut from without being read one by one.
    expect(screen.getByRole('heading', { name: 'kolin' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'elowen' })).toBeInTheDocument();
    expect(screen.getAllByTestId('sandbox-workspace-row')).toHaveLength(3);

    expect(screen.getByText('elowen/u3/payments')).toBeInTheDocument();
    // Two of the three trees are clean, so this is deliberately a count rather than a lookup.
    expect(screen.getAllByText('Clean')).toHaveLength(2);
    expect(screen.getByText('Modified files: 3')).toBeInTheDocument();
    expect(screen.getByText('Untracked files: 1')).toBeInTheDocument();
    expect(screen.getByText('Ahead: 2')).toBeInTheDocument();
    expect(screen.getByText('Orphaned')).toBeInTheDocument();
  });

  // The one thing the drawer exists to answer: which of these the conversation is actually working in.
  it('marks the workspace bound to this conversation and offers no switch to it', () => {
    renderModal();

    expect(screen.getByText('Active in this conversation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use here: Checkout' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use here: Payments' })).toBeEnabled();
    // An orphaned workspace has no worktree left to work in, so it cannot be switched to either.
    expect(screen.getByRole('button', { name: 'Use here: Docs' })).toBeDisabled();
  });

  /** Creating a workspace CREATES it, on both surfaces. The CLI used to bind the conversation to the new
   *  worktree while this drawer did not, so the same button moved the working directory in one place and
   *  not in the other. Switching is now the separate step everywhere, and the create payload is the
   *  proof: the project, the name and the base reference, and no conversation id.
   *
   *  The CLI half of this parity is asserted in tests/cli/chat/pickers.test.ts ("creates a workspace
   *  without binding this conversation, matching the web drawer"), which pins the identical payload. */
  it('creates a workspace without binding this conversation, matching the CLI', async () => {
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New workspace' })); });
    // The form says what create does BEFORE the press, not only in the toast afterwards.
    expect(screen.getByText('Creating does not move this conversation. Choose Use here to work there.')).toBeInTheDocument();
    // The base reference is the FIRST project's own default branch, read from the overview.
    const baseRef = screen.getByRole('textbox', { name: 'Base reference' });
    expect(baseRef).toHaveValue('main');

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  Refunds  ' } });
    fireEvent.change(baseRef, { target: { value: 'develop' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]![0]).toEqual({ projectId: 1, label: 'Refunds', baseRef: 'develop' });
    // No binding travels with a create, and none is written on the side either.
    expect(useMutate).not.toHaveBeenCalled();
  });

  /** The overview answers null for a repository whose default branch the daemon could not read. The form
   *  then asks for the reference instead of typing `main` into it, which used to branch a worktree from a
   *  name that need not exist in that repository at all. */
  it('leaves the base reference empty and refuses to create when the project states no default branch', async () => {
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New workspace' })); });
    // The project without a default branch is chosen through the form's own select, by keyboard —
    // Radix moves focus into the open listbox a frame later, so each step is awaited.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Project' }), { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('option'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toHaveTextContent('elowen'));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Enter' }); });

    const baseRef = screen.getByRole('textbox', { name: 'Base reference' });
    expect(baseRef).toHaveValue('');
    expect(screen.getByText('This project states no default branch, so enter the reference to branch from.')).toBeInTheDocument();

    // A name alone is not enough: with no reference there is nothing to branch from, so create stays shut.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Spike' } });
    const submit = screen.getByRole('button', { name: 'Create' });
    expect(submit).toBeDisabled();
    await act(async () => { fireEvent.click(submit); });
    expect(createMutate).not.toHaveBeenCalled();

    // Supplying one makes it the ref that travels — never a guessed default.
    fireEvent.change(baseRef, { target: { value: 'trunk' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    expect(createMutate.mock.calls[0]![0]).toEqual({ projectId: 2, label: 'Spike', baseRef: 'trunk' });
  });

  // The switch is a server-side binding of THIS conversation. Nothing about a working directory is
  // written here — the daemon derives it from the binding — so the id sent is the whole contract.
  it('switches this conversation to a workspace through the conversation id', async () => {
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use here: Payments' })); });

    expect(useMutate).toHaveBeenCalledTimes(1);
    expect(useMutate.mock.calls[0]![0]).toEqual({ workspaceId: 'ws_1', sessionId: 'brain-7-a' });
  });

  /** The inverse of the switch, and the only way to undo one without destroying a worktree. The payload is
   *  the conversation id and nothing else — no workspace is named, so nothing here can remove one.
   *
   *  The CLI half of this parity is asserted in tests/cli/chat/pickers.test.ts ("returns this conversation
   *  to its project directory and reports a refusal"), which pins the identical payload. */
  it('returns this conversation to its project directory through the conversation id, matching the CLI', async () => {
    renderModal();

    // The sentence is read BEFORE the press, because "return" alone reads like it might throw work away.
    expect(screen.getByText('Only this conversation goes back to the project directory. The workspace is kept.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Return to project' })); });

    expect(releaseMutate).toHaveBeenCalledTimes(1);
    expect(releaseMutate.mock.calls[0]![0]).toEqual({ sessionId: 'brain-7-a' });
    // No workspace was named and no removal was attempted on the side.
    expect(removeMutate).not.toHaveBeenCalled();

    const { onSuccess } = releaseMutate.mock.calls[0]![1] as { onSuccess: (r: { released: number }) => void };
    await act(async () => { onSuccess({ released: 1 }); });
    expect(toast).toHaveBeenCalledWith('Back in the project directory. The workspace has been kept.', 'ok');
  });

  it('reports a return refused by a running process and leaves every workspace in the list', async () => {
    renderModal();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Return to project' })); });

    const { onError } = releaseMutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    await act(async () => { onError({ code: 'workspace_in_use' }); });

    expect(toast).toHaveBeenCalledWith('A running process is using the workspace; nothing has been changed.', 'error');
    // A refusal changes nothing: every worktree is still listed, and the conversation is still in one.
    expect(screen.getAllByTestId('sandbox-workspace-row')).toHaveLength(3);
    expect(screen.getByText('Active in this conversation')).toBeInTheDocument();
    expect(releaseMutate).toHaveBeenCalledTimes(1);
  });

  it('asks what removal would take with it before removing anything', async () => {
    renderModal();
    await startRemoval('Checkout');

    expect(previewMutate.mock.calls[0]![0]).toEqual({ workspaceId: 'ws_2' });
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove this workspace?' });
    expect(within(confirm).getByText(/Checkout \/ kolin \/ elowen\/u3\/checkout/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Modified files: 3/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Commits present nowhere else: 2/)).toBeInTheDocument();
    // Asking is not removing: nothing has gone out until the question is answered.
    expect(removeMutate).not.toHaveBeenCalled();
  });

  // The safe path, and the only one this drawer can ask for: the body names the workspace and nothing
  // else. A `discard` here would be the difference between refusing and destroying someone's work.
  it('sends the safe removal, without discard or a confirmation phrase', async () => {
    renderModal();
    await startRemoval('Checkout');

    const confirm = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' })); });

    expect(removeMutate).toHaveBeenCalledTimes(1);
    expect(removeMutate.mock.calls[0]![0]).toEqual({ workspaceId: 'ws_2' });
  });

  it('reports a refused removal and leaves the workspace in the list', async () => {
    renderModal();
    await startRemoval('Checkout');

    const confirm = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' })); });

    const onError = removeMutate.mock.calls[0]![1].onError as (error: unknown) => void;
    await act(async () => { onError({ code: 'workspace_not_clean' }); });

    // The reason is stated where the question was asked, so the reader learns why it is still there.
    expect(await screen.findByRole('alert')).toHaveTextContent('It has uncommitted work; it was not removed.');
    // …and it IS still there: a refusal changes nothing. Queried by test id rather than by role,
    // because the open confirmation marks everything behind it inert and out of the a11y tree.
    const rows = screen.getAllByTestId('sandbox-workspace-row');
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.textContent?.includes('Checkout'))).toBe(true);
    // The drawer does not escalate a refusal into a discard: exactly one removal was ever attempted.
    expect(removeMutate).toHaveBeenCalledTimes(1);
  });

  it('uses the host session identity and disables switching when no session is attached', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<SandboxModal onClose={onClose} activeSessionId={null} />);
    expect(screen.getByRole('button', { name: 'Use here: Payments' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Return to project' })).not.toBeInTheDocument();

    rerender(<SandboxModal onClose={onClose} activeSessionId="brain-other" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use here: Payments' })); });
    expect(useMutate.mock.calls[0]![0]).toEqual({ workspaceId: 'ws_1', sessionId: 'brain-other' });
  });

  it('refreshes the list on demand', async () => {
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });
});
