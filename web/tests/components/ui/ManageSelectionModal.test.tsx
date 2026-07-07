import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ManageSelectionModal, type ManageSelectionItem } from '../../../components/ui/ManageSelectionModal';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

const ITEMS: ManageSelectionItem[] = [
  { id: 'sonnet', label: 'Claude Sonnet', group: 'claude-code', groupLabel: 'Claude Code' },
  { id: 'opus', label: 'Claude Opus', group: 'claude-code', groupLabel: 'Claude Code' },
  { id: 'codex:gpt', label: 'GPT', group: 'codex', groupLabel: 'Codex' },
  { id: 'fixed', label: 'Fixed tool', group: 'codex', groupLabel: 'Codex', disabled: true, disabledHint: 'built-in', badges: [{ text: 'built-in' }] },
];

function mount(over: Partial<React.ComponentProps<typeof ManageSelectionModal>> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <ManageSelectionModal
      title="Pick models"
      subtitle="sub"
      open
      onClose={onClose}
      items={ITEMS}
      selected={new Set(['sonnet'])}
      onSave={onSave}
      countLabel={(n) => `${n} picked`}
      {...over}
    />,
    { wrapper: W },
  );
  return { onSave, onClose };
}

describe('ManageSelectionModal', () => {
  it('renders nothing when closed', () => {
    mount({ open: false });
    expect(screen.queryByText('Pick models')).toBeNull();
  });

  it('renders grouped rows with the footer count and the selected chip', () => {
    mount();
    expect(screen.getByText('Pick models')).toBeInTheDocument();
    // Group headers for both groups.
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    // Footer count from countLabel; "1 selected" chip near the search.
    expect(screen.getByText('1 picked')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    // The preselected row reads pressed; others don't.
    expect(screen.getByRole('button', { name: /Claude Sonnet/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /GPT/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('search filters rows (diacritics/case-insensitive) and hides empty group headers', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ÓPUS' } });
    expect(screen.getByRole('button', { name: /Claude Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GPT/ })).toBeNull();
    // The Codex group has no visible items → its header hides.
    expect(screen.queryByRole('heading', { name: 'Codex' })).toBeNull();
  });

  it('shows the empty state when nothing matches the search', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-nothing' } });
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('group filter chips narrow the list to one group', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.queryByRole('button', { name: /Claude Sonnet/ })).toBeNull();
    expect(screen.getByRole('button', { name: /GPT/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByRole('button', { name: /Claude Sonnet/ })).toBeInTheDocument();
  });

  it('hides the group filter row when all items share one group', () => {
    mount({ items: ITEMS.filter((i) => i.group === 'claude-code') });
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('toggling rows and saving hands the next set to onSave, then closes', async () => {
    const { onSave, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: /GPT/ }));
    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet/ })); // deselect
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect([...(onSave.mock.calls[0][0] as Set<string>)].sort()).toEqual(['codex:gpt']);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disabled rows do not toggle', () => {
    mount();
    const fixed = screen.getByRole('button', { name: /Fixed tool/ });
    expect(fixed).toBeDisabled();
    fireEvent.click(fixed);
    expect(fixed).toHaveAttribute('aria-pressed', 'false');
  });

  it('cancel discards local changes without calling onSave', () => {
    const { onSave, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: /GPT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('nope'));
    const { onClose } = mount({ onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the empty-selection hint in the footer when nothing is selected', () => {
    mount({ selected: new Set<string>(), emptySelectionHint: 'empty = everything allowed' });
    expect(screen.getByText('empty = everything allowed')).toBeInTheDocument();
    expect(screen.queryByText('0 picked')).toBeNull();
  });
});
