import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SkillsModal } from '../../../modules/advisor/SkillsModal';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const mocks = vi.hoisted(() => ({
  deleteSkill: vi.fn(),
  loadSkill: vi.fn(),
  skill: {
    name: 'deploy',
    description: 'Deploy the application',
    source: 'user' as const,
    owner: 7,
    canDelete: true,
    disableModelInvocation: false,
    scope: 'personal',
    active: true,
  },
}));

vi.mock('../../../lib/queries', () => ({
  usePluginSkills: () => ({ data: [mocks.skill], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../lib/mutations', () => ({
  useDeletePluginSkill: () => ({ mutateAsync: mocks.deleteSkill }),
}));
vi.mock('../../../modules/advisor/BrainChatProvider', () => ({
  useBrainChat: () => ({ loadSkill: mocks.loadSkill }),
}));

function renderModal() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SkillsModal onClose={vi.fn()} /></ToastProvider></Wrapper>);
}

describe('SkillsModal deletion', () => {
  beforeEach(() => {
    mocks.deleteSkill.mockReset();
    mocks.loadSkill.mockReset();
  });

  it('keeps the confirmation open while pending and submits only once', async () => {
    let resolveDelete!: () => void;
    mocks.deleteSkill.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this skill?' });
    const remove = within(confirm).getByRole('button', { name: 'Delete' });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(mocks.deleteSkill).toHaveBeenCalledTimes(1));
    expect(confirm).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(confirm).toBeInTheDocument();

    resolveDelete();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('keeps the failed confirmation open and allows a retry', async () => {
    mocks.deleteSkill.mockRejectedValueOnce(new Error('The skill could not be deleted.'));
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this skill?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('The skill could not be deleted.')).toBeInTheDocument();
    expect(confirm).toBeInTheDocument();

    mocks.deleteSkill.mockResolvedValueOnce(undefined);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deleteSkill).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
