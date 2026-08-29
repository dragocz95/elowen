import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { LanguageProvider } from '../../../lib/i18n';
import { MOBILE_MAX_WIDTH } from '../../../lib/useMobile';
import { Segmented } from '../../../components/ui/Segmented';
import { Toggle } from '../../../components/ui/Toggle';
import { PageFilterChips, PageFilters, type PageFilterField } from '../../../components/ui/PageFilters';

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

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
];

/** A single-select filter, built the way a register would build one: the page renders the control and
 *  states its own conclusion about whether it is filtering. */
function statusField({ value = 'all', onChange = vi.fn(), onReset = vi.fn() }: {
  value?: string;
  onChange?: (next: string) => void;
  onReset?: () => void;
} = {}): PageFilterField {
  const base = {
    id: 'status',
    label: 'Status',
    control: <Segmented aria-label="Status" variant="menu" value={value} onChange={onChange} options={STATUS_OPTIONS} />,
  };
  if (value === 'all') return { ...base, active: false };
  const option = STATUS_OPTIONS.find((candidate) => candidate.value === value);
  return { ...base, active: true, activeLabel: `Status: ${option?.label ?? value}`, onReset };
}

/** A filter with no options at all — Memory's grouping switch. The old options/value contract could not
 *  express it without inventing a two-entry option list, and that invention, not the page, would then
 *  have decided whether the page was filtered. */
function groupingField({ grouped = false, onChange = vi.fn(), onReset = vi.fn() }: {
  grouped?: boolean;
  onChange?: (next: boolean) => void;
  onReset?: () => void;
} = {}): PageFilterField {
  const base = {
    id: 'grouping',
    label: 'Grouping',
    hint: 'Groups the register by category.',
    control: <Toggle checked={grouped} onChange={onChange} label="Group by category" />,
  };
  return grouped
    ? { ...base, active: true, activeLabel: 'Grouped by category', onReset }
    : { ...base, active: false };
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
    const { rerender } = render(<LanguageProvider><PageFilters fields={[statusField()]} /></LanguageProvider>);
    const trigger = screen.getByTestId('page-filters-trigger');
    expect(trigger).toHaveTextContent('Filters');
    expect(trigger).not.toHaveAttribute('aria-label');

    rerender(<LanguageProvider><PageFilters fields={[statusField({ value: 'failed' })]} /></LanguageProvider>);
    // The badge is decoration (`aria-hidden`), so the count has to reach assistive tech through the name.
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });

  it('counts a field the page declared active, never the state of the control it was handed', () => {
    // The control here sits on a NON-neutral option while the field reports itself inactive. A component
    // that inferred "active" from the control — by comparing an option value to the first entry, as the
    // first version of this contract did — would count it. This one cannot: `control` is an opaque node.
    const inferable: PageFilterField = {
      id: 'status',
      label: 'Status',
      control: <Segmented aria-label="Status" variant="menu" value="failed" onChange={vi.fn()} options={STATUS_OPTIONS} />,
      active: false,
    };
    render(<LanguageProvider><PageFilters fields={[inferable]} /><PageFilterChips fields={[inferable]} /></LanguageProvider>);

    expect(screen.getByTestId('page-filters-trigger')).not.toHaveAttribute('aria-label');
    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
  });

  it('opens a labelled dialog on a desktop popover, and returns focus to the trigger on Escape', async () => {
    render(<LanguageProvider><PageFilters fields={[statusField()]} /></LanguageProvider>);
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
    render(<LanguageProvider><PageFilters fields={[statusField()]} /></LanguageProvider>);
    fireEvent.click(screen.getByTestId('page-filters-trigger'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('[data-presentation]')).toHaveAttribute('data-presentation', 'sheet');
    expect(screen.getByRole('radiogroup', { name: 'Status' })).toBeInTheDocument();
  });

  it('holds controls it knows nothing about, each in one labelled group with its hint', async () => {
    const onChange = vi.fn();
    render(
      <LanguageProvider>
        <PageFilters fields={[statusField(), groupingField({ onChange })]} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    await screen.findByRole('dialog', { name: 'Filters' });

    // A Toggle is not a choice from an option list, and it needs no synthetic one to sit here. The
    // group names the whole control rather than the label binding to its first labelable descendant.
    const grouping = screen.getByRole('group', { name: 'Grouping' });
    expect(grouping).toContainElement(screen.getByRole('switch', { name: 'Group by category' }));
    expect(screen.getByRole('group', { name: 'Status' })).toContainElement(screen.getByRole('radiogroup', { name: 'Status' }));
    // The hint reaches the reader through the shared help affordance, not as a second paragraph.
    expect(grouping).toContainElement(screen.getByRole('button', { name: 'Help' }));

    fireEvent.click(screen.getByRole('switch', { name: 'Group by category' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('leaves the value with the page: a choice is reported, never absorbed', async () => {
    function Host() {
      const [status, setStatus] = useState('all');
      const field = statusField({ value: status, onChange: setStatus, onReset: () => setStatus('all') });
      return <LanguageProvider><PageFilters fields={[field]} /></LanguageProvider>;
    }
    render(<Host />);
    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: 'Failed' }));

    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });
});

describe('PageFilterChips', () => {
  it('shows nothing while no field reports itself active', () => {
    const { container } = render(<LanguageProvider><PageFilterChips fields={[statusField(), groupingField()]} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the wording the page wrote, for a control with no value to read', () => {
    render(<LanguageProvider><PageFilterChips fields={[groupingField({ grouped: true })]} /></LanguageProvider>);
    // A boolean filter has no option label to derive a chip from; the page says what it means.
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Grouped by category');
    expect(screen.getByRole('group', { name: 'Active filters' })).toBeInTheDocument();
  });

  it('names WHICH filter is on, not merely that one is', () => {
    render(<LanguageProvider><PageFilterChips fields={[statusField({ value: 'failed' })]} /></LanguageProvider>);
    // "Failed" alone does not say whether the page is filtered by status or by outcome.
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Status: Failed');
  });

  it('calls the field\'s own reset when pressed, whatever undoing that filter means', () => {
    const onReset = vi.fn();
    render(<LanguageProvider><PageFilterChips fields={[groupingField({ grouped: true, onReset })]} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Grouped by category' }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('offers one reset for the whole set only once more than one filter is on', () => {
    const status = vi.fn();
    const grouping = vi.fn();
    const fields = [statusField({ value: 'failed', onReset: status }), groupingField({ grouped: true, onReset: grouping })];
    const { rerender } = render(<LanguageProvider><PageFilterChips fields={fields} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(status).toHaveBeenCalledOnce();
    expect(grouping).toHaveBeenCalledOnce();

    rerender(<LanguageProvider><PageFilterChips fields={[fields[0]!]} /></LanguageProvider>);
    // With a single chip the chip itself is the reset; a second control for the same act is noise.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});
