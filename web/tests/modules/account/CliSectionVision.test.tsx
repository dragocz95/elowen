import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { interpolate } from '../../../lib/i18n';
import type { CliSettings, PermissionSettings, BrainModelOption } from '../../../lib/types';

const saveCli = vi.fn();
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
const model = (over: Partial<BrainModelOption> & Pick<BrainModelOption, 'model'>): BrainModelOption => ({
  provider: 'anthropic', providerLabel: 'Anthropic', exec: `elowen:anthropic/${over.model}`,
  source: 'oauth', contextWindow: 200000, contextWindowSet: false, ...over,
});
// The three verdicts the daemon can report: a catalogued vision model, a catalogued TEXT-ONLY model,
// and one the catalog has no row for at all (the field is absent, not `false`).
const state = vi.hoisted(() => ({ models: [] as unknown[] }));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMe: () => ({ data: { user: { id: 2, is_admin: false, allowed_execs: [] } } }),
  useMyCliSettings: () => ({ data: CLI, isLoading: false }),
  useMyPermissions: () => ({ data: PERMISSIONS, isLoading: false }),
  useBrainModels: () => ({ data: state.models }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });
const visionTrigger = () => screen.getByRole('button', { name: `${en.managePicker.manage}: ${en.cli.visionModelLabel}` });

beforeEach(() => {
  saveCli.mockClear(); savePermissions.mockClear();
  state.models = [
    model({ model: 'claude-opus', vision: true, default: true }),
    model({ model: 'text-only-x', vision: false }),
    model({ model: 'uncatalogued-y' }),
  ];
});

// MOVED with the control from the Elowen AI card into Account → Models → Model roles. The row used to
// have one unset state ("No fallback model") whatever the primary could do; it now has three honest ones.
describe('CliSection — vision fallback model picker', () => {
  it('says the primary already reads images, and carries the inherited badge', () => {
    renderSection();
    expect(screen.getByText(en.cli.visionModelLabel)).toBeTruthy();
    expect(visionTrigger()).toHaveTextContent(interpolate(en.cli.visionInherit, { model: 'claude-opus' }));
  });

  it('warns instead when the primary cannot read images at all', () => {
    // The resolved primary is now the text-only model, so inheriting would silently drop every image.
    state.models = [model({ model: 'text-only-x', vision: false, default: true }), model({ model: 'seer', vision: true })];
    renderSection();
    expect(visionTrigger()).toHaveTextContent(en.cli.visionNoFallback);
    expect(screen.getByText(en.cli.visionNoFallbackBadge)).toBeInTheDocument();
  });

  /** TRI-STATE, fail-open. `false` is a catalogued text-only model and is hidden; an ABSENT flag only
   *  means the catalog has no row, and hiding those would drop every uncatalogued model from a picker
   *  that can use it perfectly well. */
  it('offers vision-capable and uncatalogued models, and hides only the catalogued text-only one', async () => {
    renderSection();
    fireEvent.click(visionTrigger());
    expect(await screen.findByRole('button', { name: 'claude-opus' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'uncatalogued-y' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'text-only-x' })).toBeNull();
  });

  it('picking a model groups by provider (with icons) and autosaves provider::model', async () => {
    renderSection();
    fireEvent.click(visionTrigger());
    // Provider group header carries its brand logo; the model row its own model icon.
    const heading = await screen.findByRole('heading', { name: 'Anthropic' });
    expect(heading.querySelector('img')).toBeTruthy();
    const row = screen.getByRole('button', { name: 'claude-opus' });
    expect(row.querySelector('img')).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCli).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCli.mock.calls[0]![0]).toMatchObject({ visionModel: 'claude-opus', visionModelProvider: 'anthropic' });
  });
});
