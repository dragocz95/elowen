import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { LanguageProvider } from '../../../lib/i18n';
import { MOBILE_MAX_WIDTH } from '../../../lib/useMobile';
import { PageFilterChips, PageFilters, type PageFilterField, type PageFilterOption } from '../../../components/ui/PageFilters';

/** `useMobileViewport` measures the window with `matchMedia`, which jsdom does not implement. Both
 *  presentations of the same control are real branches, so the query is answered here rather than
 *  leaving the phone one untested. */
function setViewport(phone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes(`${MOBILE_MAX_WIDTH}px`),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const STATUS_OPTIONS: PageFilterOption[] = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
];

function field(overrides: Partial<PageFilterField> = {}): PageFilterField {
  return { id: 'status', label: 'Status', options: STATUS_OPTIONS, value: 'all', onChange: vi.fn(), ...overrides };
}

/** The page owns the values — the control is given them and reports back. This host is that page. */
function Host({ initial = 'all', fields }: { initial?: string; fields?: PageFilterField[] }) {
  const [status, setStatus] = useState(initial);
  const resolved = fields ?? [field({ value: status, onChange: setStatus })];
  return (
    <LanguageProvider>
      <PageFilters fields={resolved} />
      <PageFilterChips fields={resolved} />
    </LanguageProvider>
  );
}

beforeEach(() => setViewport(false));

describe('PageFilters', () => {
  it('renders nothing at all for an empty field set', () => {
    const { container } = render(<LanguageProvider><PageFilters fields={[]} /></LanguageProvider>);
    // Not "the trigger is hidden": a page with no filters must not carry a control that opens an empty
    // surface, so there is no element and no dialog to reach by any route.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names itself Filters, carries the active count and states that count for a screen reader', () => {
    const { rerender } = render(<LanguageProvider><PageFilters fields={[field()]} /></LanguageProvider>);
    const trigger = screen.getByTestId('page-filters-trigger');
    expect(trigger).toHaveTextContent('Filters');
    expect(trigger).not.toHaveAttribute('aria-label');

    rerender(<LanguageProvider><PageFilters fields={[field({ value: 'failed' })]} /></LanguageProvider>);
    // The badge is decoration (`aria-hidden`), so the count has to reach assistive tech through the name.
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });

  it('opens a labelled dialog on a desktop popover, and returns focus to the trigger on Escape', async () => {
    render(<Host />);
    const trigger = screen.getByTestId('page-filters-trigger');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Filters' });
    expect(dialog).toContainElement(screen.getByRole('radiogroup', { name: 'Status' }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opens the shared sheet dialog on a phone instead of a popover', async () => {
    setViewport(true);
    render(<Host />);
    fireEvent.click(screen.getByTestId('page-filters-trigger'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('[data-presentation]')).toHaveAttribute('data-presentation', 'sheet');
    expect(screen.getByRole('radiogroup', { name: 'Status' })).toBeInTheDocument();
  });

  it('reports a choice to the page, which owns the value', async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: 'Failed' }));

    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });
});

describe('PageFilterChips', () => {
  it('shows nothing while every field sits on its neutral value', () => {
    const { container } = render(<LanguageProvider><PageFilterChips fields={[field()]} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('names WHICH filter is on, not merely that one is', () => {
    render(<LanguageProvider><PageFilterChips fields={[field({ value: 'failed' })]} /></LanguageProvider>);
    // "Failed" alone does not say whether the page is filtered by status or by outcome.
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Status: Failed');
    expect(screen.getByRole('group', { name: 'Active filters' })).toBeInTheDocument();
  });

  it('resets its own filter to the neutral value when pressed', () => {
    const onChange = vi.fn();
    render(<LanguageProvider><PageFilterChips fields={[field({ value: 'failed', onChange })]} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status: Failed' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('honours an explicit neutral value rather than assuming the first option', () => {
    const onChange = vi.fn();
    const explicit = field({ value: 'all', neutralValue: 'done', onChange });
    render(<LanguageProvider><PageFilterChips fields={[explicit]} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status: All' }));
    expect(onChange).toHaveBeenCalledWith('done');
  });

  it('offers one reset for the whole set only once more than one filter is on', () => {
    const status = vi.fn();
    const kind = vi.fn();
    const fields = [
      field({ value: 'failed', onChange: status }),
      field({ id: 'kind', label: 'Kind', value: 'note', onChange: kind, options: [{ value: 'any', label: 'Any' }, { value: 'note', label: 'Note' }] }),
    ];
    const { rerender } = render(<LanguageProvider><PageFilterChips fields={fields} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(status).toHaveBeenCalledWith('all');
    expect(kind).toHaveBeenCalledWith('any');

    rerender(<LanguageProvider><PageFilterChips fields={[fields[0]!]} /></LanguageProvider>);
    // With a single chip the chip itself is the reset; a second control for the same act is noise.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});
