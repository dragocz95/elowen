import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../../lib/i18n';
import type { Memory } from '../../../lib/types';
import { MemoryBrainMap } from '../../../modules/memory/MemoryBrainMap';

const memory = (id: number): Memory => ({
  id, user_id: 1, body: `Memory node ${id}`, kind: 'fact', importance: 3,
  confidence: 0.9, source: 'user', status: 'active', category_id: null,
  created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  last_used_at: null, use_count: 0, vitality: 50,
});

describe('MemoryBrainMap', () => {
  it('renders all 450 memories as lightweight SVG points with one roving tab stop', () => {
    render(<LanguageProvider><MemoryBrainMap memories={Array.from({ length: 450 }, (_, index) => memory(index + 1))} categories={[]} /></LanguageProvider>);
    const leaves = screen.getAllByTestId('memory-leaf-node');
    expect(leaves).toHaveLength(450);
    expect(leaves.every((leaf) => leaf.tagName.toLowerCase() === 'circle')).toBe(true);
    expect(screen.getAllByRole('button').filter((button) => button.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.queryByText(/not shown/i)).toBeNull();
  });

  it('fits the full graph without an inner scroller and delegates memory detail to the page drawer', () => {
    const onSelectMemory = vi.fn();
    render(<LanguageProvider><MemoryBrainMap memories={[memory(1), memory(2)]} categories={[]} onSelectMemory={onSelectMemory} /></LanguageProvider>);

    expect(screen.getByTestId('brain-viewport')).toHaveClass('overflow-hidden');
    expect(screen.getByTestId('brain-viewport')).not.toHaveClass('overflow-auto');
    expect(screen.getByTestId('brain-canvas')).toHaveClass('h-full', 'w-full');

    fireEvent.click(screen.getByRole('button', { name: 'Memory node 1' }));
    expect(onSelectMemory).toHaveBeenCalledWith(1);
    expect(screen.getAllByText('Memory node 1')).toHaveLength(1);
  });

  it('keeps the selected memory label readable outside the dimmed point opacity', () => {
    render(<LanguageProvider><MemoryBrainMap memories={[memory(1), memory(2)]} categories={[]} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Memory node 1' }));
    const label = screen.getByTestId('memory-node-label');
    expect(label).toHaveTextContent('Memory node 1');
    expect(label.style.opacity).toBe('');
    const inactive = screen.getByRole('button', { name: 'Memory node 2' });
    expect(Number(inactive.getAttribute('fill-opacity'))).toBeGreaterThanOrEqual(0.4);
  });

  it('bounds memory accessible names instead of exposing a whole long body', () => {
    const long = memory(1);
    long.body = `Start ${'private detail '.repeat(500)}`;
    render(<LanguageProvider><MemoryBrainMap memories={[long]} categories={[]} /></LanguageProvider>);
    const leaf = screen.getByTestId('memory-leaf-node');
    expect(leaf.getAttribute('aria-label')?.length).toBeLessThanOrEqual(61);
    expect(leaf).toHaveAttribute('aria-label', expect.stringMatching(/^Start .*…$/));
  });

  it('moves the single keyboard focus through nodes and activates with Enter', () => {
    render(<LanguageProvider><MemoryBrainMap memories={[memory(1), memory(2)]} categories={[]} /></LanguageProvider>);
    const core = screen.getByRole('button', { name: 'Memory cortex' });
    fireEvent.focus(core);
    fireEvent.keyDown(core, { key: 'ArrowRight' });
    const first = screen.getByRole('button', { name: 'Memory node 1' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(screen.getByTestId('memory-node-label')).toHaveTextContent('Memory node 1');
  });
});
