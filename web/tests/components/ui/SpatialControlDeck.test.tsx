import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Bot, Server } from 'lucide-react';
import { LanguageProvider } from '../../../lib/i18n';
import { SpatialControlDeck, SpatialSectionRail } from '../../../components/ui/SpatialControlDeck';

const sections = [
  { id: 'system', label: 'System', description: 'Runtime and security.', icon: Server },
  { id: 'brain', label: 'Elowen AI', description: 'Providers and models.', icon: Bot },
];

function Deck({ value = 'system', onChange = vi.fn(), status = 'idle' as const, onRetry }: {
  value?: string;
  onChange?: (value: string) => void;
  status?: 'idle' | 'saving' | 'saved' | 'error';
  onRetry?: () => void;
}) {
  return (
    <LanguageProvider>
      <SpatialControlDeck
        eyebrow="Settings"
        ariaLabel="Settings sections"
        sections={sections}
        value={value}
        onChange={onChange}
        status={status}
        onRetry={onRetry}
        hero={<span>Live runtime topology</span>}
      >
        <div>Active section content</div>
      </SpatialControlDeck>
    </LanguageProvider>
  );
}

describe('SpatialControlDeck', () => {
  it('renders the active section heading, one persistent mascot, rail and content surface', () => {
    render(<Deck />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(screen.getByText('Runtime and security.')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Active section content'));
  });

  it('uses roving focus and keyboard selection across the section rail', () => {
    const onChange = vi.fn();
    render(<Deck onChange={onChange} />);
    const system = screen.getByRole('radio', { name: 'System' });
    const brain = screen.getByRole('radio', { name: 'Elowen AI' });
    expect(system).toHaveAttribute('tabindex', '0');
    expect(brain).toHaveAttribute('tabindex', '-1');
    system.focus();
    fireEvent.keyDown(system, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('brain');
    expect(brain).toHaveFocus();
  });

  it('turns vertical wheel input into horizontal rail movement without showing a scrollbar', () => {
    render(<Deck />);
    const rail = screen.getByTestId('spatial-section-rail');
    const scrollBy = vi.fn();
    Object.defineProperty(rail, 'scrollBy', { value: scrollBy });
    fireEvent.wheel(rail, { deltaY: 72, deltaX: 0 });
    expect(scrollBy).toHaveBeenCalledWith({ left: 72, behavior: 'auto' });
  });

  it('exposes the shared rail with live counts and complete roving-keyboard navigation', () => {
    const onChange = vi.fn();
    render(<SpatialSectionRail ariaLabel="Task status" sections={[
      { id: 'active', label: 'Active', icon: Server, count: 4 },
      { id: 'all', label: 'All', icon: Bot, count: 12 },
    ]} value="active" onChange={onChange} />);

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    const active = screen.getByRole('radio', { name: /Active/ });
    const all = screen.getByRole('radio', { name: /All/ });
    fireEvent.keyDown(active, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('all');
    expect(all).toHaveFocus();
    fireEvent.keyDown(all, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('active');
    expect(active).toHaveFocus();
  });

  it('keeps failed auto-save retry in the hero', () => {
    const retry = vi.fn();
    render(<Deck status="error" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
