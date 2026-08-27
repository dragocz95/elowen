import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../lib/i18n';
import { dictionaries, type Locale } from '../../lib/i18n/dictionaries';
import { Pager } from '../../components/ui/Pager';

function wrapper(locale: Locale = 'en') {
  return function W({ children }: { children: React.ReactNode }) {
    return <LanguageProvider initialLocale={locale}>{children}</LanguageProvider>;
  };
}

describe('Pager', () => {
  it('derives the range, the page label and the page count from page/pageSize/total', () => {
    render(<Pager page={1} pageSize={25} total={57} onPageChange={vi.fn()} />, { wrapper: wrapper() });
    expect(screen.getByText('26–50 of 57')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('reports an empty register as 0–0 and keeps a single page', () => {
    render(<Pager page={0} pageSize={25} total={0} onPageChange={vi.fn()} />, { wrapper: wrapper() });
    expect(screen.getByText('0–0 of 0')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
  });

  it('steps the zero-based page and disables the ends', () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pager page={0} pageSize={10} total={30} onPageChange={onPageChange} />,
      { wrapper: wrapper() },
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    rerender(<Pager page={2} pageSize={10} total={30} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('announces the current page politely', () => {
    render(<Pager page={0} pageSize={10} total={30} onPageChange={vi.fn()} />, { wrapper: wrapper() });
    expect(screen.getByText('Page 1 of 3')).toHaveAttribute('aria-live', 'polite');
  });

  it('names the navigation landmark, and lets a caller name it after its table', () => {
    const { rerender } = render(<Pager page={0} pageSize={10} total={30} onPageChange={vi.fn()} />, { wrapper: wrapper() });
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    rerender(<Pager page={0} pageSize={10} total={30} onPageChange={vi.fn()} ariaLabel="Memories" />);
    expect(screen.getByRole('navigation', { name: 'Memories' })).toBeInTheDocument();
  });

  // The bug this component exists for: at a 320px viewport the old inline pager laid the "next" button
  // out from x=265 to x=357, outside a container with `overflow-x-hidden`, so page 2 could not be
  // opened at all — and whether it clipped depended on how long the locale's label happened to be.
  describe('narrow container (the unreachable "next" button)', () => {
    it.each(Object.keys(dictionaries) as Locale[])('keeps both controls operable in %s', (locale) => {
      const onPageChange = vi.fn();
      render(<Pager page={0} pageSize={10} total={30} onPageChange={onPageChange} />, { wrapper: wrapper(locale) });
      const next = screen.getByRole('button', { name: dictionaries[locale].pagination.nextPage });
      const previous = screen.getByRole('button', { name: dictionaries[locale].pagination.previousPage });
      // The accessible name lives on the button, not in the text, so it survives the collapse.
      expect(next.getAttribute('aria-label')).toBe(dictionaries[locale].pagination.nextPage);
      expect(previous.getAttribute('aria-label')).toBe(dictionaries[locale].pagination.previousPage);
      // Every character of the visible label sits inside the element the container query hides, so no
      // locale can widen the control row past a narrow container.
      const labels = [dictionaries[locale].pagination.previous, dictionaries[locale].pagination.next];
      for (const label of labels) {
        expect(screen.getByText(label)).toHaveClass('@max-[24rem]:hidden');
      }
      fireEvent.click(next);
      expect(onPageChange).toHaveBeenCalledWith(1);
    });

    it('wraps instead of overflowing, and is its own query container', () => {
      render(<Pager page={0} pageSize={10} total={30} onPageChange={vi.fn()} />, { wrapper: wrapper() });
      const nav = screen.getByRole('navigation');
      // A container query rather than a viewport one: the pager also sits inside narrow detail rails.
      expect(nav).toHaveClass('@container');
      expect(nav).toHaveClass('flex-wrap');
      const controls = screen.getByRole('button', { name: 'Next page' }).parentElement;
      expect(controls).toHaveClass('flex-wrap');
      expect(controls).toHaveClass('min-w-0');
    });
  });
});
