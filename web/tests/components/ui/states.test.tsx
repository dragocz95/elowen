import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { EmptyState, LoadingState, LoadingLine, Spinner, ErrorState } from '../../../components/ui/states';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('states', () => {
  it('EmptyState shows title', () => { render(<EmptyState title="Nothing here" />, { wrapper: W }); expect(screen.getByText('Nothing here')).toBeInTheDocument(); });
  it('ErrorState shows message and retry fires', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="boom" onRetry={onRetry} />, { wrapper: W });
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('ErrorState announces the failure and paints it in the destructive tone', () => {
    // Two halves of the same defect. The block REPLACES the content the request was for, so without a
    // live region a screen-reader user is left waiting on a region that never fills in — and the message
    // was painted `text-primary`, which is only error-coloured by coincidence of the built-in ember: under
    // studio-light the primary is a signal blue, so a failure was announced in the colour of a link.
    render(<ErrorState message="Could not load memories." />, { wrapper: W });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load memories.');
    const title = screen.getByText('Could not load memories.');
    expect(title.className).toContain('text-destructive');
    expect(title.className).not.toContain('text-primary');
  });
});

// Loading is one of the states a screen reader has to be told about, not just drawn. These check what a
// user actually gets — announced text and a busy marker — rather than which class names were applied.

describe('LoadingState (skeleton)', () => {
  it('announces itself as busy so a screen reader does not read an empty region', () => {
    render(<LoadingState />, { wrapper: W });
    expect(screen.getByLabelText('Loading…')).toHaveAttribute('aria-busy', 'true');
  });

  it('draws every variant through the shared skeleton class, so reduced effects reaches all of them', () => {
    // `.skeleton` is where the reduced-effects rule hangs; a hand-rolled `animate-pulse` block silently
    // opts out of it, which is how the memory chart used to keep moving.
    for (const variant of ['list', 'cards', 'kanban', 'block'] as const) {
      const { container, unmount } = render(<LoadingState variant={variant} />, { wrapper: W });
      expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('sizes the block variant from its prop, since a chart placeholder must match the chart', () => {
    const { container } = render(<LoadingState variant="block" height="h-40" />, { wrapper: W });
    expect(container.querySelector('.skeleton')).toHaveClass('h-40');
  });
});

describe('LoadingLine (text)', () => {
  it('falls back to the shared wording, so one label is not spelled three ways', () => {
    render(<LoadingLine />, { wrapper: W });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('prefers a specific label when the context has a better one', () => {
    render(<LoadingLine label="Loading models…" />, { wrapper: W });
    expect(screen.getByRole('status')).toHaveTextContent('Loading models…');
  });

  it('is a polite live region rather than an alert', () => {
    // Loading is not an interruption; announcing it assertively would talk over the user.
    render(<LoadingLine />, { wrapper: W });
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('inherits the surrounding typography when inline', () => {
    // Inline lines sit among sibling rows (a dropdown, a log tail) and must match those, not the app.
    const { container } = render(<LoadingLine layout="inline" />, { wrapper: W });
    expect(container.querySelector('span > span')).not.toHaveClass('font-mono');
  });
});

describe('Spinner', () => {
  it('is announced only when it carries its own label', () => {
    render(<Spinner label="Loading older messages" />, { wrapper: W });
    expect(screen.getByRole('status', { name: 'Loading older messages' })).toBeInTheDocument();
  });

  it('is hidden from screen readers when it merely decorates visible text', () => {
    // Otherwise "Saving… Saving…" — once for the spinner, once for the words next to it.
    const { container } = render(<Spinner />, { wrapper: W });
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('offers a fixed set of sizes, which is the point of having it', () => {
    const px = { xs: '10', sm: '13', md: '16', lg: '40' } as const;
    for (const [size, expected] of Object.entries(px)) {
      const { container, unmount } = render(<Spinner size={size as keyof typeof px} />, { wrapper: W });
      expect(container.firstElementChild).toHaveAttribute('width', expected);
      unmount();
    }
  });
});
