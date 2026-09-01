import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import { SettingsDocument, SettingsGroup } from '../../../components/ui/SettingsSurface';

const useConfig = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ useConfig }));
vi.mock('../../../lib/mutations', () => ({ useUpdateConfig: () => ({ mutateAsync, isPending: false }) }));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { SkinsRow } from '../../../modules/settings/SkinsRow';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const renderRow = () => render(
  <LanguageProvider>
    <SettingsDocument><SettingsGroup><SkinsRow /></SettingsGroup></SettingsDocument>
  </LanguageProvider>,
);

describe('SkinsRow', () => {
  beforeEach(() => {
    useConfig.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
  });

  /** The record's trailing side is ONE control. It used to be a `SelectionSummary`: a count line above
   *  sample chips and a "+N", with the manage button beside them — content that cannot share the single
   *  grid row a settings record is, so the row wrapped and its value fell under its own label. */
  it('carries exactly one control and no sample chips', () => {
    useConfig.mockReturnValue({ data: { allowedSkins: ['studio-light', 'studio-oled'] } });
    const { container } = renderRow();

    const row = container.querySelector('.settings-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.settings-row__control')).toHaveLength(1);
    expect(row!.querySelectorAll('.settings-row__control button')).toHaveLength(1);
    expect(row!.querySelector('.settings-row__actions')).toBeNull();
    expect(container.querySelector('[data-selection-summary]')).toBeNull();

    // The count IS the summary — the names live in the dialog the control opens.
    const trigger = screen.getByRole('button', { name: en.settings.skins.manage });
    expect(trigger).toHaveTextContent(en.managePicker.selectedCount.replace('{n}', '2'));
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(en.common.skinNames.studioLight)).toBeNull();
  });

  it('summarises an empty allowlist as switching disabled and opens the picker', () => {
    useConfig.mockReturnValue({ data: { allowedSkins: [] } });
    renderRow();

    const trigger = screen.getByRole('button', { name: en.settings.skins.manage });
    expect(trigger).toHaveTextContent(en.settings.skins.none);

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /** The trigger is a row picker, so it has to be addressable as one. Studio's narrowest container query
   *  trades a picker's inline padding for its label, and it selects `[data-row-picker]` — a trigger that
   *  does not carry the hook keeps its full padding while every other picker in the same column gives it
   *  up, and truncates its own label to pay for it. The stylesheet half is asserted too, so the hook and
   *  the rule that consumes it cannot be renamed apart. */
  it('wears the canonical row-picker hook the narrow Studio padding addresses', () => {
    useConfig.mockReturnValue({ data: { allowedSkins: ['studio-light'] } });
    const { container } = renderRow();

    const trigger = screen.getByRole('button', { name: en.settings.skins.manage });
    expect(trigger).toHaveAttribute('data-row-picker');
    expect(container.querySelector('.settings-row__control [data-row-picker]')).toBe(trigger);

    const studioSurfaces = readFileSync(join(WEB, 'skins', 'studio', 'surfaces.css'), 'utf-8');
    expect(studioSurfaces).toContain('.settings-row__trailing [data-row-picker]');
  });

  /** Unknown stored values are not live designs. */
  it('offers only the two compiled designs', () => {
    useConfig.mockReturnValue({ data: { allowedSkins: ['default', 'studio-light', 'studio-oled', 'retired-skin'] } });
    renderRow();

    const trigger = screen.getByRole('button', { name: en.settings.skins.manage });
    expect(trigger).toHaveTextContent(en.managePicker.selectedCount.replace('{n}', '2'));
    fireEvent.click(trigger);
    expect(screen.queryByText('Default')).toBeNull();
    expect(screen.getByText(en.common.skinNames.studioLight)).toBeInTheDocument();
    expect(screen.getByText(en.common.skinNames.studioOled)).toBeInTheDocument();
  });

  it('autosaves a changed selection and exposes Retry after failure', async () => {
    useConfig.mockReturnValue({ data: { allowedSkins: ['studio-light'] } });
    mutateAsync.mockRejectedValueOnce(new Error('offline'));
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: en.settings.skins.manage }));
    fireEvent.click(screen.getByRole('button', { name: en.common.skinNames.studioOled }));
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ allowedSkins: ['studio-light', 'studio-oled'] }), { timeout: 2000 });
    expect(screen.getByRole('button', { name: en.common.retry })).toBeInTheDocument();

    mutateAsync.mockResolvedValueOnce({ allowedSkins: ['studio-light', 'studio-oled'] });
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(en.common.saved)).toBeInTheDocument();
  });
});
