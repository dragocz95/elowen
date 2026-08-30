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
  it('renders the active section heading, horizontal tabs and content surface', () => {
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

  // SpatialSectionRail remains a public legacy primitive for bundles that mount it directly. The deck
  // itself uses WorkspaceShell's shared Segmented tabs, so the rail's independent behaviour stays covered
  // here without implying that SpatialControlDeck renders it.
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

  it('consumes vertical wheel input only while the legacy rail can move horizontally', () => {
    render(<SpatialSectionRail ariaLabel="Task status" sections={[
      { id: 'active', label: 'Active', icon: Server },
    ]} value="active" onChange={vi.fn()} />);
    const rail = screen.getByTestId('spatial-section-rail');

    const fitting = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 72 });
    fireEvent(rail, fitting);
    expect(fitting.defaultPrevented).toBe(false);

    Object.defineProperties(rail, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 260 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    const forward = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 72 });
    fireEvent(rail, forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(rail.scrollLeft).toBe(72);

    rail.scrollLeft = 160;
    const bounded = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 72 });
    fireEvent(rail, bounded);
    expect(bounded.defaultPrevented).toBe(false);
  });

  it('keeps failed auto-save retry in the heading', () => {
    const retry = vi.fn();
    render(<Deck status="error" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
