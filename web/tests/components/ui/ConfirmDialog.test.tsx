import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('ConfirmDialog', () => {
  it('renders title, description, confirm and cancel when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete model"
        description="Remove my/custom?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: W },
    );
    expect(screen.getAllByText('Delete model').length).toBeGreaterThan(0);
    expect(screen.getByText('Remove my/custom?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('fires onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={vi.fn()} onClose={onClose} />, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="Delete model" onConfirm={onConfirm} onClose={vi.fn()} />, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="Delete model" onConfirm={vi.fn()} onClose={vi.fn()} />,
      { wrapper: W },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
