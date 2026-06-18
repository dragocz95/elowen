import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { EmptyState, LoadingState, ErrorState } from '../../../components/ui/states';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('states', () => {
  it('EmptyState shows title', () => { render(<EmptyState title="Nothing here" />, { wrapper: W }); expect(screen.getByText('Nothing here')).toBeInTheDocument(); });
  it('LoadingState shows a label', () => { render(<LoadingState label="Loading" />, { wrapper: W }); expect(screen.getByText('Loading')).toBeInTheDocument(); });
  it('ErrorState shows message and retry fires', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="boom" onRetry={onRetry} />, { wrapper: W });
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
