import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { interpolate } from '../../../lib/i18n';
import type { EmbeddingSettings, CategorizationSettings, BrainModelOption } from '../../../lib/types';

const saveCategorization = vi.fn();
const saveEmbedding = vi.fn();
const updateConfig = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useSaveEmbeddingSettings: () => ({ mutate: saveEmbedding, mutateAsync: saveEmbedding }),
  useSaveCategorizationSettings: () => ({ mutate: saveCategorization, mutateAsync: saveCategorization }),
  useUpdateConfig: () => ({ mutate: updateConfig, mutateAsync: updateConfig }),
}));

const EMBEDDING: EmbeddingSettings = { providerId: 'openai', model: 'text-embedding-3-small', baseUrl: '', dimensions: 1536, configured: true };
const CATEGORIZATION: CategorizationSettings = { providerId: 'anthropic', model: 'claude-haiku', baseUrl: '', configured: true };
// `claude-opus` is what the daemon marks as the model the SPAWN PATH resolves, and it is deliberately
// NOT first in this list: reading list order (what `serverDefault` effectively answers) would name
// `claude-haiku` instead, so the fixture can tell the two rules apart.
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku', exec: 'elowen:anthropic/claude-haiku', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false, default: true },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'text-embedding-3-small', exec: 'elowen:openai/text-embedding-3-small', source: 'api-key', contextWindow: 8192, contextWindowSet: false },
  // A model id that itself contains a slash: the pickers group by the PROVIDER field, never by splitting
  // this string, and the saved route must carry the full id.
  { provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'openai/gpt-5.6-sol', exec: 'elowen:chatgpt-account/openai/gpt-5.6-sol', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
];
const state = vi.hoisted(() => ({ digest: { providerId: '', model: '' }, personalModel: '', embeddingError: false, categorizationError: false }));
const mocks = vi.hoisted(() => ({ refetchEmbedding: vi.fn(), refetchCategorization: vi.fn() }));
const CONFIG = () => ({
  brain: { providers: [{ id: 'anthropic', label: 'Anthropic', type: 'oauth-anthropic' }, { id: 'openai', label: 'OpenAI', type: 'openai' }] },
  dashboard: { recapEnabled: true, digestEnabled: true, greetingEnabled: false, pillsEnabled: false, continueEnabled: true, digestPerDay: 1, digest: state.digest },
});
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: CONFIG() }),
  useEmbeddingSettings: () => (state.embeddingError
    ? { data: undefined, isError: true, refetch: mocks.refetchEmbedding }
    : { data: EMBEDDING, isError: false, refetch: mocks.refetchEmbedding }),
  useCategorizationSettings: () => (state.categorizationError
    ? { data: undefined, isError: true, refetch: mocks.refetchCategorization }
    : { data: CATEGORIZATION, isError: false, refetch: mocks.refetchCategorization }),
  useBrainModels: () => ({ data: MODELS }),
  useMyCliSettings: () => ({ data: { model: state.personalModel } }),
}));

import { ModelRolesSection } from '../../../modules/settings/ModelRolesSection';

const renderSection = (onOpenSection?: (id: string) => void) =>
  render(<ToastProvider><ModelRolesSection onOpenSection={onOpenSection} /></ToastProvider>, { wrapper: createWrapper().wrapper });

/** The group folds closed by default, and `getByRole` does not see into `hidden` content (it leaves the
 *  accessibility tree). Tests that drive the rows therefore OPEN the group first — that is the query
 *  being aligned with the new default, not a workaround for a regression: the rows themselves are always
 *  in the DOM (pinned by the "still in the DOM" test below). */
const openModelRolesGroup = (container: HTMLElement) => {
  fireEvent.click(container.querySelector('.settings-group__trigger')!);
  expect(container.querySelector('.settings-group__trigger')).toHaveAttribute('aria-expanded', 'true');
};

const pick = (rowLabel: string) => screen.getByRole('button', { name: `${en.managePicker.manage}: ${rowLabel}` });

beforeEach(() => {
  saveCategorization.mockClear(); saveEmbedding.mockClear(); updateConfig.mockClear();
  mocks.refetchEmbedding.mockClear(); mocks.refetchCategorization.mockClear();
  state.digest = { providerId: '', model: '' };
  state.personalModel = '';
  state.embeddingError = false; state.categorizationError = false;
});

// MOVED from MemorySection.test.tsx with the rows: the embedding and categorization forms are the same
// two writers they were, they just live in the Model roles group now.
describe('Settings → Models — moved memory forms', () => {
  it('shows a retryable error instead of a permanent skeleton when embedding settings fail to load', () => {
    state.embeddingError = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: en.managePicker.manage })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchEmbedding).toHaveBeenCalledOnce();
  });

  it('shows a retryable error when categorization settings fail to load', () => {
    state.categorizationError = true;
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchCategorization).toHaveBeenCalledOnce();
  });

  it('gives the custom model and optional dimensions inputs explicit translated names', () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    expect(screen.getByRole('textbox', { name: en.memory.embeddingModelCustom })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: en.memory.embeddingDimensions })).toHaveValue(1536);
  });

  /** The pinned empty row used to read "None"; it now says what an empty pair MEANS for this role — the
   *  titles, the memory curator and the categorizer simply stop running. */
  it('clears the utility route back to the empty pair through its pinned off row', async () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    fireEvent.click(pick(en.settings.modelRoles.utility));
    const dialog = screen.getByRole('dialog', { name: en.settings.modelRoles.utility });
    fireEvent.click(within(dialog).getByRole('button', { name: en.settings.modelRoles.utilityOff }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCategorization).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCategorization.mock.calls.at(-1)![0]).toMatchObject({ providerId: '', model: '' });
  });
});

describe('Settings → Models — Model roles', () => {
  /** The role records are INLINE records like every other row in Settings: the trailing side is ONE line
   *  (a short status badge, at most one compact action) and the picker trigger is the part inside it that
   *  shrinks. `trailingLayout="stack"` here used to give the utility, digest and embedding rows a
   *  full-width band; nothing in their trailing sides needs it any more. */
  it('keeps every record of the group on the single trailing line, with the picker trigger inside', () => {
    const { container } = renderSection();
    openModelRolesGroup(container);
    const group = container.querySelector('[data-settings-group]')!;
    const rows = Array.from(group.querySelectorAll('.settings-row')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveAttribute('data-trailing', 'inline');
    // …and each picker row carries its trigger in the trailing container, so the one line holds the value.
    const trailingPicker = (label: string) => rows
      .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(label))!
      .querySelector('.settings-row__trailing [data-row-picker]');
    expect(trailingPicker(en.settings.modelRoles.utility)).not.toBeNull();
    expect(trailingPicker(en.settings.modelRoles.digest)).not.toBeNull();
    expect(trailingPicker(en.memory.embeddingProvider)).not.toBeNull();
  });

  it('answers "which model does what" in one group, above the catalog', () => {
    const { container } = renderSection();
    openModelRolesGroup(container);
    const rows = Array.from(container.querySelectorAll('.settings-row__title > span:first-child')).map((n) => n.textContent);
    expect(rows).toEqual([
      en.settings.modelRoles.instanceDefault,
      en.settings.modelRoles.utility,
      en.settings.modelRoles.digest,
      en.memory.embeddingProvider,
      en.memory.embeddingModel,
      en.memory.embeddingModelCustom,
      en.memory.embeddingDimensions,
      en.settings.modelRoles.personal,
    ]);
    // The Test action and both configured badges travelled with the rows they belong to. Anchored per
    // row, because the two badges read the same word and only their placement tells them apart.
    const rowOf = (index: number) => container.querySelectorAll('.settings-row')[index]! as HTMLElement;
    expect(within(rowOf(3)).getByRole('button', { name: en.memory.embeddingTest })).toBeInTheDocument();
    expect(rowOf(3).querySelector('.settings-row__status')!.textContent).toBe(en.memory.embeddingConfigured);
    expect(rowOf(1).querySelector('.settings-row__status')!.textContent).toBe(en.categorization.configured);
  });

  /** The row must state what the RUNTIME resolves. `serverDefault` returns the first EXPLICITLY configured
   *  model, which differs from the spawn path's answer for a provider with an empty manual list — so this
   *  reads `BrainModelOption.default`, the flag the daemon computes with the spawn path's own rule. */
  it('reads the instance default off the catalog flag and offers no picker for it', () => {
    const { container } = renderSection();
    const row = container.querySelector('.settings-row')!;
    // `claude-haiku` is the catalog's FIRST entry; naming it here would mean the row reports list order
    // rather than what the next conversation would actually start on.
    expect(row.querySelector('.settings-row__status')!.textContent).toBe('claude-opus');
    expect(row.querySelector('[data-row-picker]')).toBeNull();
  });

  it('shows the digest inheriting the utility model, and drops the badge on an explicit pick', async () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    const trigger = pick(en.settings.modelRoles.digest);
    // Without opening anything, the trigger already names the model the digest actually runs on.
    expect(trigger).toHaveTextContent(interpolate(en.settings.modelRoles.inherit, { model: 'claude-haiku' }));
    expect(screen.getByText(en.settings.modelRoles.inherited)).toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: en.settings.modelRoles.digest });
    fireEvent.click(within(dialog).getByRole('button', { name: 'claude-opus' }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ dashboard: { digest: { providerId: 'anthropic', model: 'claude-opus' } } }));
    expect(screen.queryByText(en.settings.modelRoles.inherited)).toBeNull();
  });

  /** Clearing back to inherit must PERSIST the empty pair — a half-set pair would be read as an explicit
   *  route the daemon cannot resolve, and leaving the old value in place would silently ignore the click. */
  it('persists a clear back to inherit as the empty pair', async () => {
    state.digest = { providerId: 'anthropic', model: 'claude-opus' };
    const view = renderSection();
    openModelRolesGroup(view.container);
    const trigger = pick(en.settings.modelRoles.digest);
    expect(trigger).toHaveTextContent('claude-opus');
    expect(screen.queryByText(en.settings.modelRoles.inherited)).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: en.settings.modelRoles.digest });
    fireEvent.click(within(dialog).getByRole('button', { name: interpolate(en.settings.modelRoles.inherit, { model: 'claude-haiku' }) }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ dashboard: { digest: { providerId: '', model: '' } } }));
    expect(await screen.findByText(en.settings.modelRoles.inherited)).toBeInTheDocument();
  });

  it('writes the utility route as one provider+model pair', async () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    fireEvent.click(pick(en.settings.modelRoles.utility));
    const dialog = screen.getByRole('dialog', { name: en.settings.modelRoles.utility });
    fireEvent.click(within(dialog).getByRole('button', { name: 'claude-opus' }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCategorization).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCategorization.mock.calls.at(-1)![0]).toMatchObject({ providerId: 'anthropic', model: 'claude-opus' });
  });

  // The role pickers separate their catalog under one header per brain provider, each header carrying
  // that provider's brand mark, and a model whose MODEL id itself contains a slash (`openai/gpt-5.6-sol`)
  // stays one whole row in its provider's group — the first slash segment must not become a group, and
  // the persisted route keeps the full model id rather than a split at the slash.
  it('groups picker rows under brand-iconed provider headers and saves a slash model id whole', async () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    fireEvent.click(pick(en.settings.modelRoles.utility));
    const dialog = screen.getByRole('dialog', { name: en.settings.modelRoles.utility });

    // One header per brain provider, each carrying the provider's brand mark.
    const headerMark = (name: string) => within(dialog).getByRole('heading', { name }).querySelector('[data-brand-mark]');
    expect(within(dialog).getByRole('heading', { name: 'Anthropic' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'OpenAI' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Účet ChatGPT' })).toBeTruthy();
    expect(headerMark('Anthropic')).toBeTruthy();
    expect(headerMark('OpenAI')).toBeTruthy();
    expect(headerMark('Účet ChatGPT')).toBeTruthy();
    // The group filter chips carry the same brand mark with the human label.
    expect(within(within(dialog).getByRole('tablist')).getByRole('tab', { name: 'Účet ChatGPT' }).querySelector('[data-brand-mark]')).toBeTruthy();

    // The slash never became a provider boundary: no group is named after either identifier half.
    expect(within(dialog).queryByRole('heading', { name: 'chatgpt-account' })).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'openai' })).toBeNull();

    // Exactly one row for the model, in the Účet ChatGPT section — then save keeps the identity whole.
    const rows = within(dialog).getAllByRole('button', { name: 'openai/gpt-5.6-sol' });
    expect(rows).toHaveLength(1);
    const section = rows[0]!.closest('section')!;
    expect(within(section).getByRole('heading', { name: 'Účet ChatGPT' })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'claude-opus' })).toBeNull();

    fireEvent.click(rows[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(saveCategorization).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCategorization.mock.calls.at(-1)![0]).toMatchObject({ providerId: 'chatgpt-account', model: 'openai/gpt-5.6-sol' });
  });

  it('keeps every OAuth account out of the embedding picker and states why', () => {
    const view = renderSection();
    openModelRolesGroup(view.container);
    fireEvent.click(screen.getByRole('button', { name: en.memory.embeddingProvider }));
    const dialog = screen.getByRole('dialog', { name: en.memory.embeddingProvider });
    // Anthropic is a connected OAuth account: it exposes no embedding endpoint, so it is not offered.
    expect(within(dialog).queryByRole('button', { name: 'Anthropic' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('sends the reader to the account roles and to the providers that decide what exists', () => {
    const onOpenSection = vi.fn();
    const view = renderSection(onOpenSection);
    openModelRolesGroup(view.container);
    fireEvent.click(screen.getByRole('button', { name: en.settings.modelRoles.providersLink }));
    expect(onOpenSection).toHaveBeenCalledWith('brain');
    fireEvent.click(screen.getByRole('button', { name: en.settings.modelRoles.recapLink }));
    expect(onOpenSection).toHaveBeenCalledWith('dashboard');
    expect(screen.getByRole('link', { name: en.settings.modelRoles.openAccount })).toHaveAttribute('href', '/account?cat=cli');
  });
});

/** The fold itself. The group ships CLOSED so the deck reads as one-line summaries, and the rows stay
 *  MOUNTED under `hidden` — the sibling deep-link task anchors `data-row-id`s into this body and opens
 *  the group programmatically through the controlled props, which only works while the rows exist. */
describe('Settings → Models — the collapsed group', () => {
  /** EIGHT rows: instance default, utility, digest, embedding provider/model/custom/dimensions, personal. */
  it('starts collapsed with every row still in the DOM', () => {
    const { container } = renderSection();
    const group = container.querySelector('[data-settings-group]')!;
    const trigger = container.querySelector('.settings-group__trigger')!;

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('type', 'button');
    const body = group.querySelector('.settings-group__body')!;
    expect(body).toHaveAttribute('hidden');
    // Closed yet present: all eight records, with the summary carrying what the fold hides.
    expect(group.querySelectorAll('.settings-row')).toHaveLength(8);
    expect(group.querySelector('.settings-group__heading p')!.textContent).toBe(en.settings.modelRoles.hint);
  });

  it('opens on the header trigger and hands the rows back to the accessibility tree', () => {
    const { container } = renderSection();
    const trigger = container.querySelector('.settings-group__trigger') as HTMLElement;
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.settings-group__body')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('textbox', { name: en.memory.embeddingModelCustom })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.memory.embeddingTest })).toBeInTheDocument();
  });
});
