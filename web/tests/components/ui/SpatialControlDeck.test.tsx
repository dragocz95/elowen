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
      >
        <div>Active section content</div>
      </SpatialControlDeck>
    </LanguageProvider>
  );
}

describe('SpatialControlDeck', () => {
  it('renders the active section heading, rail and content surface', () => {
    render(<Deck />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(screen.getByText('Runtime and security.')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Active section content'));
  });

  it('lets the keyboard move between sections', () => {
    const onChange = vi.fn();
    render(<Deck onChange={onChange} />);
    const brain = screen.getByRole('radio', { name: 'Elowen AI' });
    fireEvent.click(brain);
    expect(onChange).toHaveBeenCalledWith('brain');
  });

  // The rail is mounted directly rather than through the deck: the deck reads the shell profile, and
  // every design this build ships is a command profile, which mounts the segmented navigation instead.
  // The rail is still exported and still a fork's page anatomy, so its behaviour is covered here where
  // it is the subject, not left half-asserted behind a profile nothing selects.
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
    // Roving focus: one stop in the tab order, and the arrows move it.
    expect(active).toHaveAttribute('tabindex', '0');
    expect(all).toHaveAttribute('tabindex', '-1');
    active.focus();
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('all');
    expect(all).toHaveFocus();
    fireEvent.keyDown(active, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('all');
    fireEvent.keyDown(all, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('active');
    expect(active).toHaveFocus();
  });

  it('turns vertical wheel input into horizontal rail movement without showing a scrollbar', () => {
    render(<SpatialSectionRail ariaLabel="Task status" sections={[
      { id: 'active', label: 'Active', icon: Server },
    ]} value="active" onChange={vi.fn()} />);
    const rail = screen.getByTestId('spatial-section-rail');
    const scrollBy = vi.fn();
    Object.defineProperty(rail, 'scrollBy', { value: scrollBy });
    fireEvent.wheel(rail, { deltaY: 72, deltaX: 0 });
    expect(scrollBy).toHaveBeenCalledWith({ left: 72, behavior: 'auto' });
  });

  it('keeps failed auto-save retry in the heading', () => {
    const retry = vi.fn();
    render(<Deck status="error" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
