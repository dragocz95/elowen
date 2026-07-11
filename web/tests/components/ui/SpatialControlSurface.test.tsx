import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Bot, Plug } from 'lucide-react';
import { SpatialControlSurface } from '../../../components/ui/SpatialControlSurface';
import { LanguageProvider } from '../../../lib/i18n';

const sections = [
  { id: 'brain', label: 'Elowen AI', description: 'AI providers', icon: Bot },
  { id: 'plugins', label: 'Plugins', description: 'Extensions', icon: Plug },
];

describe('SpatialControlSurface', () => {
  it('renders one accessible section selector and keeps the document content mounted', () => {
    const onChange = vi.fn();
    render(<LanguageProvider>
      <SpatialControlSurface ariaLabel="Settings sections" sections={sections} value="brain" onChange={onChange}>
        <div>Unsaved panel content</div>
      </SpatialControlSurface>
    </LanguageProvider>);
    expect(screen.getAllByRole('radiogroup', { name: 'Settings sections' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Plugins' }));
    expect(onChange).toHaveBeenCalledWith('plugins');
    expect(screen.getByText('Unsaved panel content')).toBeInTheDocument();
  });

  it('uses roving focus and arrow keys across sections', () => {
    const onChange = vi.fn();
    render(<LanguageProvider>
      <SpatialControlSurface ariaLabel="Settings sections" sections={sections} value="brain" onChange={onChange}>
        <div>Panel</div>
      </SpatialControlSurface>
    </LanguageProvider>);
    const first = screen.getByRole('radio', { name: 'Elowen AI' });
    const second = screen.getByRole('radio', { name: 'Plugins' });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('plugins');
    expect(second).toHaveFocus();
  });

  it('shows the active section explanation and failed-save retry in its header', () => {
    const retry = vi.fn();
    render(<LanguageProvider>
      <SpatialControlSurface ariaLabel="Settings sections" sections={sections} value="brain" onChange={vi.fn()} status="error" onRetry={retry}>
        <div>Panel</div>
      </SpatialControlSurface>
    </LanguageProvider>);
    expect(screen.getByText('AI providers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
