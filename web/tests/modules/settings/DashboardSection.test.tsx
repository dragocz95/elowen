import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CategorizationSettings } from '../../../lib/types';

const updateConfig = vi.fn();
vi.mock('../../../lib/mutations', () => ({ useUpdateConfig: () => ({ mutate: updateConfig, mutateAsync: updateConfig }) }));

const CATEGORIZATION: CategorizationSettings = { providerId: 'anthropic', model: 'claude-haiku', baseUrl: '', configured: true };
const state = vi.hoisted(() => ({
  digest: { providerId: '', model: '' } as { providerId: string; model: string },
  variants: 5,
}));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: {
    brain: { providers: [{ id: 'anthropic', label: 'Anthropic', type: 'oauth-anthropic' }] },
    dashboard: {
      recapEnabled: true, digestEnabled: true, greetingEnabled: false, pillsEnabled: false,
      continueEnabled: true, digestPerDay: 1, digestVariants: state.variants, digest: state.digest,
    },
  } }),
  useCategorizationSettings: () => ({ data: CATEGORIZATION }),
  useDashRecap: () => ({ data: { digest: { status: 'ready' } } }),
}));

import { DashboardSection } from '../../../modules/settings/DashboardSection';

const renderSection = (onOpenSection?: (id: string) => void) =>
  render(<ToastProvider><DashboardSection onOpenSection={onOpenSection} /></ToastProvider>, { wrapper: createWrapper().wrapper });

const digestRow = (container: HTMLElement) => Array.from(container.querySelectorAll('.settings-row'))
  .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.settings.dashboardSection.model))!;

const variantsRow = (container: HTMLElement) => Array.from(container.querySelectorAll('.settings-row'))
  .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.settings.dashboardSection.variants))!;

beforeEach(() => {
  updateConfig.mockClear();
  state.digest = { providerId: '', model: '' };
  state.variants = 5;
});

/** Which model writes the digest is a ROLE now — Recap only states the answer. The rule it states is the
 *  daemon's own (`dashDigestInference`): the digest route counts only when BOTH halves are set. */
describe('Settings → Recap — the read-only digest model row', () => {
  it('names an explicit digest model, with no inherited badge', () => {
    state.digest = { providerId: 'anthropic', model: 'claude-opus' };
    const { container } = renderSection();
    const row = digestRow(container);
    expect(row.querySelector('.settings-row__status')!.textContent).toContain('claude-opus');
    expect(row.querySelector('.settings-row__status')!.textContent).not.toContain(en.settings.modelRoles.inherited);
  });

  it('names the utility model it inherits when no digest pair is stored', () => {
    const { container } = renderSection();
    const status = digestRow(container).querySelector('.settings-row__status')!;
    expect(status.textContent).toContain('claude-haiku');
    expect(status.textContent).toContain(en.settings.modelRoles.inherited);
  });

  /** THE REGRESSION. A half-set stored pair is not a route: the daemon falls through to the utility one.
   *  Reading `digest.model || categorization.model` reported the orphaned half as the digest model. */
  it.each([
    ['no provider', { providerId: '', model: 'orphaned-model' }],
    ['no model', { providerId: 'anthropic', model: '' }],
  ])('reads a half-set pair (%s) as inherited, exactly as the daemon does', (_label, digest) => {
    state.digest = digest;
    const { container } = renderSection();
    const status = digestRow(container).querySelector('.settings-row__status')!;
    expect(status.textContent).toContain('claude-haiku');
    expect(status.textContent).toContain(en.settings.modelRoles.inherited);
    expect(status.textContent).not.toContain('orphaned-model');
  });

  it('reports no model at all when neither route is complete', () => {
    state.digest = { providerId: 'anthropic', model: '' };
    CATEGORIZATION.model = ''; // the utility route is half-set too, so nothing resolves
    const { container } = renderSection();
    expect(digestRow(container).querySelector('.settings-row__status')!.textContent).toContain('—');
    CATEGORIZATION.model = 'claude-haiku';
  });

  it('sends the reader to the roles rather than editing the model here', () => {
    const onOpenSection = vi.fn();
    renderSection(onOpenSection);
    fireEvent.click(screen.getByRole('button', { name: en.settings.dashboardSection.modelLink }));
    expect(onOpenSection).toHaveBeenCalledWith('models');
    // No picker: the digest model is chosen beside the roles it inherits from.
    expect(digestRow(document.body).querySelector('[data-row-picker]')).toBeNull();
  });
});

/** The batch size a generation writes. It must never be confused with `perDay` above it: one says how
 *  OFTEN a run may happen, the other how many variants ONE run writes. */
describe('Settings → Recap — the variants-per-generation row', () => {
  it('defaults to 5 per batch when the daemon predates the setting', () => {
    state.variants = undefined as unknown as number;
    const { container } = renderSection();
    const trigger = variantsRow(container).querySelector('[data-row-picker]');
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveTextContent(en.settings.dashboardSection.variantsOption.replace('{n}', '5'));
  });

  it('shows the saved count and keeps it apart from the runs-per-day row', () => {
    state.variants = 3;
    const { container } = renderSection();
    expect(variantsRow(container).querySelector('[data-row-picker]'))
      .toHaveTextContent(en.settings.dashboardSection.variantsOption.replace('{n}', '3'));
    expect(variantsRow(container).querySelector('.settings-row__title')!.textContent)
      .not.toContain(en.settings.dashboardSection.perDay);
  });

  it('persists the picked count alongside the untouched frequency', async () => {
    updateConfig.mockResolvedValue({});
    const { container } = renderSection();
    fireEvent.click(variantsRow(container).querySelector('[data-row-picker]')!);
    fireEvent.click(screen.getByRole('button', { name: en.settings.dashboardSection.variantsOption.replace('{n}', '1') }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const patch = updateConfig.mock.calls.at(-1)![0].dashboard;
    expect(patch.digestVariants).toBe(1);
    // One variant means no rotation on the dashboard — the count reaches generation, not the toggles.
    expect(patch.digestPerDay).toBe(1);
  });
});
