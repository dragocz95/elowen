import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ToastProvider, useToast } from '../../../components/ui/Toast';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }
function Trigger() {
  const { toast } = useToast();
  return <button onClick={() => toast('Launched orca-A', 'ok')}>go</button>;
}

describe('Toast', () => {
  it('shows a toast message when fired', () => {
    render(<ToastProvider><Trigger /></ToastProvider>, { wrapper: W });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('Launched orca-A')).toBeInTheDocument();
  });
});
