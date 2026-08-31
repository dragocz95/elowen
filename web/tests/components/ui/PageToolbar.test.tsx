import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ControlSurfaceToolbar } from '../../../components/ui/ControlSurface';
import { Segmented } from '../../../components/ui/Segmented';
import {
  PageToolbar,
  PageToolbarPortal,
  PageToolbarProvider,
  PageToolbarScope,
} from '../../../components/ui/PageToolbar';
import type { PageFilterField } from '../../../components/ui/PageFilters';

const statusField: PageFilterField = {
  id: 'status',
  label: 'Status',
  control: <Segmented aria-label="Status" variant="menu" value="failed" onChange={vi.fn()} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }]} />,
  active: true,
  activeLabel: 'Status: Failed',
  onReset: vi.fn(),
};

const parts = (element: Element | null): string[] =>
  [...(element?.children ?? [])].map((child) => child.className.split(' ')[0]!);

describe('PageToolbar', () => {
  it('puts the active chips on a line of THEIR OWN under the row, never inside it', () => {
    render(
      <LanguageProvider>
        <PageToolbarProvider>
          <PageToolbar search={<input aria-label="Search" />} filters={[statusField]} actions={<button type="button">New</button>} />
        </PageToolbarProvider>
      </LanguageProvider>,
    );

    const toolbar = screen.getByTestId('page-toolbar');
    // A chip appearing and disappearing inside the row would reflow it, moving the controls beside it
    // out from under the pointer every time a filter is set.
    expect(parts(toolbar)).toEqual(['page-toolbar__row', 'page-filters__chips']);
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Status: Failed');
  });

  it('lays the row out as search, filters, the portal slot, then actions', () => {
    render(
      <LanguageProvider>
        <PageToolbarProvider>
          <PageToolbar search={<input aria-label="Search" />} filters={[statusField]} actions={<button type="button">New</button>} />
        </PageToolbarProvider>
      </LanguageProvider>,
    );

    const row = screen.getByTestId('page-toolbar').firstElementChild!;
    const children = [...row.children];
    const at = (element: Element | null) => children.indexOf(element!);
    expect(at(row.querySelector('.page-toolbar__search'))).toBe(0);
    expect(at(screen.getByTestId('page-filters-trigger'))).toBe(1);
    expect(at(screen.getByTestId('page-toolbar-slot'))).toBe(2);
    expect(at(row.querySelector('.page-toolbar__actions'))).toBe(3);
  });

  it('mounts no dictionary consumer for a page that declares no filters', () => {
    // Deliberately WITHOUT a LanguageProvider: the shell mounts this row on every page, and making the
    // canonical page shell throw outside a provider in exchange for two components that would return
    // null immediately is a coupling nobody asked for. `useTranslation` throws, so this is a real check.
    expect(() => render(
      <PageToolbarProvider>
        <PageToolbar actions={<button type="button">New</button>} />
      </PageToolbarProvider>,
    )).not.toThrow();
    expect(screen.queryByTestId('page-filters-trigger')).toBeNull();
    expect(screen.getByTestId('page-toolbar-slot')).toBeEmptyDOMElement();
  });
});

describe('structured nested toolbar contributions', () => {
  it('publishes search, condensed filters, chips and actions through the canonical row', () => {
    const { container } = render(
      <LanguageProvider>
        <PageToolbarProvider>
          <PageToolbar />
          <div data-testid="content">
            <ControlSurfaceToolbar
              search={<input aria-label="Search jobs" />}
              filters={[statusField]}
              actions={<button type="button">New job</button>}
            />
          </div>
        </PageToolbarProvider>
      </LanguageProvider>,
    );

    const toolbar = screen.getByTestId('page-toolbar');
    expect(toolbar).toContainElement(screen.getByRole('textbox', { name: 'Search jobs' }));
    expect(toolbar).toContainElement(screen.getByTestId('page-filters-trigger'));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'New job' }));
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Status: Failed');
    expect(container.querySelector('.control-surface-toolbar')).toBeNull();
  });

  it('lets a hidden retained contribution release the row to the visible panel', () => {
    const Panels = ({ active }: { active: 'first' | 'second' }) => (
      <LanguageProvider>
        <PageToolbarProvider>
          <PageToolbar />
          <PageToolbarScope active={active === 'first'}>
            <ControlSurfaceToolbar search={<input aria-label="First search" />} filters={[]} />
          </PageToolbarScope>
          <PageToolbarScope active={active === 'second'}>
            <ControlSurfaceToolbar search={<input aria-label="Second search" />} filters={[]} />
          </PageToolbarScope>
        </PageToolbarProvider>
      </LanguageProvider>
    );

    const { rerender } = render(<Panels active="first" />);
    expect(screen.getByRole('textbox', { name: 'First search' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Second search' })).toBeNull();

    rerender(<Panels active="second" />);
    expect(screen.getByRole('textbox', { name: 'Second search' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'First search' })).toBeNull();
  });
});

describe('the toolbar portal', () => {
  it('moves the first page-level toolbar into the slot and leaves later ones where they are', () => {
    render(
      <PageToolbarProvider>
        <PageToolbar />
        <div data-testid="content">
          <PageToolbarPortal><button type="button">Promoted</button></PageToolbarPortal>
          <PageToolbarPortal><button type="button">Nested</button></PageToolbarPortal>
        </div>
      </PageToolbarProvider>,
    );

    expect(screen.getByTestId('page-toolbar-slot')).toContainElement(screen.getByRole('button', { name: 'Promoted' }));
    expect(screen.getByTestId('content')).toContainElement(screen.getByRole('button', { name: 'Nested' }));
  });

  it('renders in place when no toolbar row published a slot', () => {
    // The plugin page frame and a few bare mounts have no shell around them; the controls must still
    // appear rather than vanish into a portal with no destination.
    render(<PageToolbarPortal><button type="button">Promoted</button></PageToolbarPortal>);
    expect(screen.getByRole('button', { name: 'Promoted' })).toBeInTheDocument();
  });

  it('lets a hidden retained panel release the slot to the visible one', () => {
    const Panels = ({ active }: { active: 'first' | 'second' }) => (
      <PageToolbarProvider>
        <PageToolbar />
        {/* Both stay MOUNTED — that is the point of the scope. */}
        <PageToolbarScope active={active === 'first'}>
          <PageToolbarPortal><button type="button">First</button></PageToolbarPortal>
        </PageToolbarScope>
        <PageToolbarScope active={active === 'second'}>
          <PageToolbarPortal><button type="button">Second</button></PageToolbarPortal>
        </PageToolbarScope>
      </PageToolbarProvider>
    );

    const { rerender } = render(<Panels active="first" />);
    expect(screen.getByTestId('page-toolbar-slot')).toContainElement(screen.getByRole('button', { name: 'First' }));

    rerender(<Panels active="second" />);
    expect(screen.getByTestId('page-toolbar-slot')).toContainElement(screen.getByRole('button', { name: 'Second' }));
  });
});
