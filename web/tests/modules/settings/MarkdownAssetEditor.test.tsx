import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import { EffectsProvider } from '../../../lib/useEffects';
import { Badge } from '../../../components/ui/Badge';

vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { MarkdownAssetEditor, type MarkdownAsset } from '../../../modules/settings/MarkdownAssetEditor';

interface TestAsset extends MarkdownAsset { version?: number; manualOnly?: boolean }

const labels = {
  empty: 'No entries', badgeUser: 'Custom', badgeBuiltin: 'Built-in', edit: 'Edit', remove: 'Delete',
  save: 'Save', cancel: 'Cancel', name: 'Name', nameHint: '', namePlaceholder: '', description: 'Description',
  descriptionHint: '', body: 'Body', bodyHint: '', created: 'Created', updated: 'Updated', deleted: 'Deleted',
  deleteTitle: 'Delete entry', deleteDesc: 'Delete {name}?', addTitle: 'New entry',
};

const assets: TestAsset[] = [
  { name: 'alpha-skill', description: 'The first custom entry', source: 'user', version: 3, manualOnly: true },
  { name: 'bundled-skill', description: 'A bundled entry', source: 'bundled' },
];

function renderEditor(data: TestAsset[] = assets, extra: Record<string, unknown> = {}) {
  const query = { data, isLoading: false, isError: false, refetch: vi.fn() };
  return render(
    <EffectsProvider>
      <LanguageProvider>
        <MarkdownAssetEditor<TestAsset, unknown>
          // The component only reads data/isLoading/isError/refetch off the query result.
          query={query as never}
          labels={labels}
          emptyForm={{ editing: null, name: '', description: '', body: '' }}
          formFromItem={(item) => ({ editing: item.name, name: item.name, description: item.description, body: 'content' })}
          renderBadges={(item) => (
            <>
              {item.version != null ? <Badge tone="default">v{item.version}</Badge> : null}
              {item.manualOnly ? <Badge tone="default">Manual only</Badge> : null}
            </>
          )}
          onSave={vi.fn()}
          saving={false}
          onDelete={vi.fn()}
          creating={false}
          onCreatingChange={vi.fn()}
          {...extra}
        />
      </LanguageProvider>
    </EffectsProvider>,
  );
}

const openName = (name: string) => en.assetEditor.openRow.replace('{name}', name);
const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="row"]:not(.data-table-header)'));

describe('MarkdownAssetEditor register', () => {
  it('opens an editable row through one row-wide control with a short accessible name', () => {
    const { container } = renderEditor();
    const openControls = screen.getAllByRole('button', { name: openName('alpha-skill') });
    expect(openControls).toHaveLength(1);
    expect(openControls[0]).toHaveClass('data-table-row-open');
    // The label names the entry, not the row's whole text — the description must not be read out with it.
    expect(openControls[0].getAttribute('aria-label')).not.toContain('The first custom entry');

    // The name cell is text only: the button buried in it was a second tab stop for the same action.
    const nameCell = within(bodyRows(container)[0]).getAllByRole('cell')[0];
    expect(nameCell.querySelector('button')).toBeNull();
    expect(nameCell).toHaveTextContent('alpha-skill');

    fireEvent.click(openControls[0]);
    expect(screen.getByDisplayValue('alpha-skill')).toBeInTheDocument();
  });

  it('leaves a read-only entry without an open control or a chevron', () => {
    const { container } = renderEditor();
    expect(screen.queryByRole('button', { name: openName('bundled-skill') })).toBeNull();
    const builtinRow = bodyRows(container)[1];
    expect(builtinRow.querySelector('.data-table-row-open')).toBeNull();
    expect(builtinRow.querySelector('.data-table-chevron')).toBeNull();
    expect(builtinRow.querySelector('button')).toBeNull();
  });

  it('reserves the chevron track in both grid templates and renders the affordance', () => {
    const { container } = renderEditor();
    const table = container.querySelector<HTMLElement>('[role="table"]')!;
    expect(table.style.getPropertyValue('--data-table-columns').trim().endsWith('1.25rem')).toBe(true);
    expect(table.style.getPropertyValue('--data-table-compact-columns').trim().endsWith('1.25rem')).toBe(true);
    expect(bodyRows(container)[0].querySelector('.data-table-chevron')).not.toBeNull();
  });

  it('keeps one row rhythm with several badges in the same cell', () => {
    const { container } = renderEditor();
    for (const row of bodyRows(container)) expect(row.dataset.rowHeight).toBe('standard');

    const badgeCell = within(bodyRows(container)[0]).getAllByRole('cell')[2];
    expect(badgeCell).toHaveTextContent('Custom');
    expect(badgeCell).toHaveTextContent('v3');
    expect(badgeCell).toHaveTextContent('Manual only');
    // Single truncated line: wrapping this cell is what stacked the badges and deformed the register.
    expect(badgeCell.dataset.lines).toBe('1');
    expect(badgeCell.className).not.toContain('flex-wrap');
  });

  it('keeps the delete action reachable rather than hover-only', () => {
    const { container } = renderEditor();
    const deleteCell = bodyRows(container)[0].querySelector<HTMLElement>('[data-reveal="hover"]')!;
    expect(within(deleteCell).getByRole('button', { name: labels.remove })).toBeInTheDocument();
    expect(deleteCell.dataset.lines).toBe('auto');
  });

  /** Search and the add action are what every visit reaches for, so they stay in the row; the one
   *  narrowing control folds behind the shared filter surface and reports itself as a chip. */
  it('keeps search and the add action visible and folds the source filter behind the filter control', async () => {
    renderEditor(assets, { addAction: <button type="button">New entry</button> });

    expect(screen.getByLabelText(en.assetEditor.search)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New entry' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: en.assetEditor.filterBuiltin })).toBeNull();

    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    fireEvent.click(await screen.findByRole('radio', { name: en.assetEditor.filterUser }));

    const chips = await screen.findByTestId('page-filter-chips');
    expect(within(chips).getByText(`${en.assetEditor.colSource}: ${en.assetEditor.filterUser}`)).toBeInTheDocument();
    expect(screen.getByText('alpha-skill')).toBeInTheDocument();
    expect(screen.queryByText('bundled-skill')).toBeNull();

    fireEvent.click(within(chips).getByRole('button'));
    expect(screen.getByText('bundled-skill')).toBeInTheDocument();
    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
  });

  /** An asset type with ownership scopes narrows the same set more finely, so it gets ONE filter — its
   *  scopes — and never the coarse source filter beside it. */
  it('offers the ownership scope as the only filter when the caller declares one', async () => {
    renderEditor(assets, {
      ownership: {
        header: 'Scope',
        label: () => 'Instance',
        scopes: [{ value: 'mine', label: 'Mine', matches: (item: TestAsset) => item.source === 'user' }],
      },
    });

    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    expect(await screen.findByRole('radio', { name: 'Mine' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: en.assetEditor.filterBuiltin })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    const chips = await screen.findByTestId('page-filter-chips');
    expect(within(chips).getByText('Scope: Mine')).toBeInTheDocument();
    expect(screen.queryByText('bundled-skill')).toBeNull();
  });

  /** The form is the shared dialog's body and footer. The actions used to be the last child of the scroll
   *  region behind a hand-drawn top rule — the divider the footer already paints. */
  it('pins the form actions in the dialog footer instead of the scrolling body', () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: openName('alpha-skill') })[0]);

    const save = screen.getByRole('button', { name: labels.save });
    const footer = save.closest('.border-t');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole('button', { name: labels.cancel })).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByRole('button', { name: labels.remove })).toBeInTheDocument();
    // The body scrolls; the footer does not live inside it.
    const body = container.ownerDocument.querySelector('.overflow-y-auto.overscroll-contain');
    expect(body).not.toBeNull();
    expect(body!.contains(save)).toBe(false);
  });
});
