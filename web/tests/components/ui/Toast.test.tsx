import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from '../../../components/ui/Toast';

function Trigger() {
  const { toast } = useToast();
  return <button onClick={() => toast('Launched orca-A', 'ok')}>go</button>;
}

describe('Toast', () => {
  it('shows a toast message when fired', () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('Launched orca-A')).toBeInTheDocument();
  });
});
