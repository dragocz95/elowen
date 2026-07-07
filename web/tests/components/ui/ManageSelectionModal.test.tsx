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

  it('falls back to the generic "{n} selected" footer when countLabel is omitted', () => {
    mount({ countLabel: undefined });
    // Header chip + footer both read the generic count.
    expect(screen.getAllByText('1 selected')).toHaveLength(2);
  });
});

// Pinned rows (group '') + single-select mode — the cron channel/model picker pattern.
const PICK_ITEMS: ManageSelectionItem[] = [
  { id: '', label: 'Default', group: '' },
  { id: 'a', label: 'general', group: 'channel', groupLabel: 'Channels' },
  { id: 'b', label: 'help', group: 'thread', groupLabel: 'Threads' },
];

describe('ManageSelectionModal pinned rows', () => {
  it('renders group-less items without a header or filter chip, surviving a group filter', () => {
    mount({ items: PICK_ITEMS, selected: new Set(['a']) });
    // Filter chips: All + the two real groups only — nothing for the pinned row.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'help' })).toBeNull();
  });
});

describe('ManageSelectionModal single mode', () => {
  it('a row click REPLACES the selection and save hands over the one picked id', async () => {
    const { onSave } = mount({ single: true, items: PICK_ITEMS, selected: new Set(['a']) });
    fireEvent.click(screen.getByRole('button', { name: 'help' }));
    expect(screen.getByRole('button', { name: 'help' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect([...(onSave.mock.calls[0][0] as Set<string>)]).toEqual(['b']);
  });

  it('clicking the already selected row keeps it selected (radio semantics)', () => {
    mount({ single: true, items: PICK_ITEMS, selected: new Set(['a']) });
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
    expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('header chip and footer show the chosen label instead of a count', () => {
    mount({ single: true, items: PICK_ITEMS, selected: new Set(['']) });
    // Row + header chip + footer all read the pinned Default label.
    expect(screen.getAllByText('Default')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'help' }));
    expect(screen.getAllByText('help')).toHaveLength(3);
  });

  it('an unknown saved id passed as a pinned item stays visible and selected', () => {
    mount({
      single: true,
      items: [...PICK_ITEMS, { id: 'zzz', label: 'zzz', group: '' }],
      selected: new Set(['zzz']),
    });
    expect(screen.getByRole('button', { name: 'zzz' })).toHaveAttribute('aria-pressed', 'true');
  });
});
