import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { interpolate } from '../../../lib/i18n';
import type { CliSettings, PermissionSettings, BrainModelOption } from '../../../lib/types';

const saveCli = vi.fn(async (patch: Record<string, unknown>) => ({ ...state.cli, ...patch }));
const savePermissions = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useSaveMyCliSettings: () => ({ mutate: saveCli, mutateAsync: saveCli }),
  useSaveMyPermissions: () => ({ mutate: savePermissions, mutateAsync: savePermissions }),
}));

const CLI: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoLiveRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false, vision: true, default: true },
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku', exec: 'elowen:anthropic/claude-haiku', source: 'oauth', contextWindow: 200000, contextWindowSet: false, vision: true },
];
const state = vi.hoisted(() => ({ cli: {} as Record<string, unknown>, isAdmin: false, allowedExecs: [] as string[] }));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMe: () => ({ data: { user: { id: 2, is_admin: state.isAdmin, allowed_execs: state.allowedExecs } } }),
  useMyCliSettings: () => ({ data: state.cli, isLoading: false }),
  useMyPermissions: () => ({ data: PERMISSIONS, isLoading: false }),
  useBrainModels: () => ({ data: MODELS }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });
const pick = (label: string) => screen.getByRole('button', { name: `${en.managePicker.manage}: ${label}` });

beforeEach(() => {
  saveCli.mockClear(); savePermissions.mockClear();
  state.cli = { ...CLI };
  state.isAdmin = false;
  state.allowedExecs = [];
});

describe('Account → Models — Model roles', () => {
  it('reads the personal roles top-down, with the runtime switches in a second group', () => {
    const { container } = renderSection();
    const groups = container.querySelectorAll('[data-settings-group]');
    expect(Array.from(groups).map((g) => g.querySelector('h2')?.textContent)).toEqual([
      en.settings.modelRoles.title, en.cli.chatRuntimeTitle,
    ]);
    const rowsOf = (group: Element) => Array.from(group.querySelectorAll('.settings-row__title > span:first-child')).map((n) => n.textContent);
    expect(rowsOf(groups[0]!)).toEqual([
      en.cli.primaryModelLabel, en.cli.thinkingLabel, en.cli.visionModelLabel,
      en.cli.compactModelLabel, en.cli.projectModelsTitle,
    ]);
    expect(rowsOf(groups[1]!)).toContain(en.cli.autoCompact);
    expect(rowsOf(groups[1]!)).toContain(en.cli.yoloTitle);
  });

  /** MOVED here from Account → Account, where the personal default sat two rail entries away from the
   *  vision and compaction models it decides. Unset it now NAMES the instance default it inherits. */
  it('seeds the primary model on the instance default it inherits and patches only the pair', async () => {
    renderSection();
    expect(pick(en.cli.primaryModelLabel)).toHaveTextContent(interpolate(en.settings.modelRoles.inherit, { model: 'claude-opus' }));

    fireEvent.click(pick(en.cli.primaryModelLabel));
    const dialog = screen.getByRole('dialog', { name: en.cli.primaryModelLabel });
    fireEvent.click(within(dialog).getByRole('button', { name: 'claude-haiku' }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));

    // ONLY the pair: the PATCH merges, so this must not carry this section's other drafts with it.
    await waitFor(() => expect(saveCli).toHaveBeenCalledWith({ model: 'claude-haiku', modelProvider: 'anthropic' }));
  });

  it('shows the pins the chat picker wrote and clears one in a single click', async () => {
    state.cli = { ...CLI, projectModelPreferences: {
      '/var/www/kolin': { provider: 'anthropic', model: 'claude-haiku' },
      '/var/www/elowen': { provider: 'anthropic', model: 'claude-opus' },
    } };
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.projectModelsTitle))!;
    expect(row.querySelector('.settings-row__status')!.textContent).toBe(interpolate(en.cli.projectModelsCount, { n: '2' }));

    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: en.managePicker.manage }));
    expect(await screen.findByText('/var/www/kolin')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.cli.projectModelsClear.replace('{project}', '/var/www/kolin') }));

    // The map replaces wholesale, so the cleared entry is simply absent from the write.
    await waitFor(() => expect(saveCli).toHaveBeenCalledWith({
      projectModelPreferences: { '/var/www/elowen': { provider: 'anthropic', model: 'claude-opus' } },
    }));
  });

  it('reports no pins at all rather than an empty list', () => {
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.projectModelsTitle))!;
    expect(row.querySelector('.settings-row__status')!.textContent).toBe(en.cli.projectModelsNone);
  });

  /** /settings is admin-only and answers a non-admin with a stop page, so the row must not exist for
   *  them — a cross-link into a refusal is worse than no cross-link. */
  it('offers the instance cross-link to an admin and to nobody else', () => {
    renderSection();
    expect(screen.queryByText(en.cli.instanceModelsTitle)).toBeNull();
    expect(screen.queryByRole('link', { name: en.cli.openSettings })).toBeNull();

    state.isAdmin = true;
    renderSection();
    expect(screen.getByText(en.cli.instanceModelsTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.cli.openSettings })).toHaveAttribute('href', '/settings?cat=models');
  });

  /** The personal allow-list narrows every picker on this page, admin or not. It can only ever hide a
   *  model — `isOfferableExec` on the daemon stays the single existence bound. */
  it('narrows every role picker by the caller\'s own allow-list', async () => {
    state.allowedExecs = ['elowen:anthropic/claude-haiku'];
    renderSection();
    fireEvent.click(pick(en.cli.primaryModelLabel));
    expect(await screen.findByRole('button', { name: 'claude-haiku' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'claude-opus' })).toBeNull();
  });
});
