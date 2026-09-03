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
// The model the daemon marks `default` is deliberately NOT first: reading list order instead of the
// flag would name `claude-haiku`, so the fixture can tell the two rules apart.
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku', exec: 'elowen:anthropic/claude-haiku', source: 'oauth', contextWindow: 200000, contextWindowSet: false, vision: true },
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false, vision: true, default: true },
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

  /** The role records are INLINE records like every other row of the surfaces: the trailing side is ONE
   *  line (a short status badge, at most one compact action) and the picker trigger is the part inside it
   *  that shrinks. These rows never declared `trailingLayout="stack"` — this pins that contract so a
   *  stacked band cannot creep back in. */
  it('keeps every model-role record on the single trailing line, with the picker trigger inside', () => {
    const { container } = renderSection();
    const group = container.querySelectorAll('[data-settings-group]')[0]!;
    const rows = Array.from(group.querySelectorAll('.settings-row')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveAttribute('data-trailing', 'inline');
    // …and each picker row carries its trigger in the trailing container, so the one line holds the value.
    const trailingPicker = (label: string) => rows
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(label))!
      .querySelector('.settings-row__trailing [data-row-picker]');
    expect(trailingPicker(en.cli.primaryModelLabel)).not.toBeNull();
    expect(trailingPicker(en.cli.visionModelLabel)).not.toBeNull();
    expect(trailingPicker(en.cli.compactModelLabel)).not.toBeNull();
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

  /** BLOCKER 1a. `/brain/models` strips models outside `allowed_execs` for a member, but the RUNTIME
   *  still starts an empty personal choice on the instance default (`selectionAllowed` judges COMPLETE
   *  selections only). Looking the default up in the personal catalog therefore found nothing and the row
   *  showed a bare "Inherited" with no model. It reads the daemon's `serverDefaultRoute` instead. */
  it('names the instance default even when the personal catalog does not contain it', () => {
    state.allowedExecs = ['elowen:anthropic/claude-haiku']; // the default, claude-opus, is filtered out
    state.cli = { ...CLI, serverDefaultRoute: { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus' } };
    renderSection();
    expect(pick(en.cli.primaryModelLabel)).toHaveTextContent(interpolate(en.settings.modelRoles.inherit, { model: 'claude-opus' }));
    // …and not the bare "Inherit" with nothing behind it, which is what the personal-catalog lookup gave.
    expect(pick(en.cli.primaryModelLabel).textContent?.trim()).not.toBe(en.cli.inheritUnknown);
  });

  /** BLOCKER 1b. A stored pick whose provider or model is no longer offered is NOT what runs: the spawn
   *  chain skips it and starts on the instance default, and compaction discards a stale pick. Rendering
   *  the bare id as the active model is the lie. */
  it('marks an unavailable primary and names the model that runs instead', () => {
    state.cli = {
      ...CLI, model: 'ghost-model', modelProvider: 'deleted-provider',
      serverDefaultRoute: { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus' },
    };
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.primaryModelLabel))!;
    expect(row.querySelector('.settings-row__status')!.textContent).toBe(en.cli.unavailableBadge);
    expect(pick(en.cli.primaryModelLabel)).toHaveTextContent(
      interpolate(en.cli.unavailableSummary, { model: 'ghost-model', fallback: 'claude-opus' }),
    );
  });

  it('marks an unavailable compaction pick and names the primary it falls back to', () => {
    state.cli = { ...CLI, model: 'claude-haiku', modelProvider: 'anthropic', compactModel: 'ghost', compactModelProvider: 'deleted-provider' };
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.compactModelLabel))!;
    expect(row.querySelector('.settings-row__status')!.textContent).toBe(en.cli.unavailableBadge);
    expect(pick(en.cli.compactModelLabel)).toHaveTextContent(
      interpolate(en.cli.unavailableSummary, { model: 'ghost', fallback: 'claude-haiku' }),
    );
  });

  it('marks an unavailable vision pick', () => {
    state.cli = { ...CLI, model: 'claude-haiku', modelProvider: 'anthropic', visionModel: 'ghost', visionModelProvider: 'deleted-provider' };
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.visionModelLabel))!;
    expect(row.querySelector('.settings-row__status')!.textContent).toBe(en.cli.unavailableBadge);
  });

  it('marks an unavailable project pin in the drawer and still clears it in one click', async () => {
    state.cli = {
      ...CLI, model: 'claude-haiku', modelProvider: 'anthropic',
      projectModelPreferences: { '/var/www/kolin': { provider: 'deleted-provider', model: 'ghost' } },
    };
    const { container } = renderSection();
    const row = Array.from(container.querySelectorAll('.settings-row'))
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.cli.projectModelsTitle))!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: en.managePicker.manage }));

    expect(await screen.findByText('/var/www/kolin')).toBeInTheDocument();
    expect(screen.getByText(en.cli.unavailableBadge)).toBeInTheDocument();
    expect(screen.getByText(interpolate(en.cli.projectPinFallback, { fallback: 'claude-haiku' }))).toBeInTheDocument();
    // Clearing a dead pin is the whole point of showing it.
    fireEvent.click(screen.getByRole('button', { name: en.cli.projectModelsClear.replace('{project}', '/var/www/kolin') }));
    await waitFor(() => expect(saveCli).toHaveBeenCalledWith({ projectModelPreferences: {} }));
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
