import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { RowPicker } from '../../../components/ui/RowPicker';
import type { ManageSelectionItem } from '../../../components/ui/ManageSelectionModal';

const ITEMS: ManageSelectionItem[] = [
  { id: '', label: 'None', group: '' },
  { id: 'opus', label: 'Claude Opus', group: 'anthropic', groupLabel: 'Anthropic' },
  { id: 'gpt', label: 'GPT-5', group: 'openai', groupLabel: 'OpenAI' },
];

function Harness({ onChange = () => {}, initial = 'opus' }: { onChange?: (v: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  const selected = ITEMS.find((item) => item.id === value);
  return (
    <RowPicker
      label="Vision model"
      summary={selected?.label ?? value}
      items={ITEMS}
      value={value}
      onChange={(next) => { setValue(next); onChange(next); }}
    />
  );
}

function mount(props: Parameters<typeof Harness>[0] = {}) {
  return render(<LanguageProvider><Harness {...props} /></LanguageProvider>);
}

describe('RowPicker', () => {
  it('is one compact trigger named for the field, showing the current pick — not a summary card', () => {
    const { container } = mount();

    const trigger = screen.getByRole('button', { name: 'Vision model' });
    expect(trigger).toHaveTextContent('Claude Opus');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The card this replaced. A record's trailing cell is one line tall, and a bordered block with a
    // count line, sample chips and a Manage button beside them is not that.
    expect(container.querySelector('[data-selection-summary]')).toBeNull();
    // One control in the record, not a control plus an affordance that opens it.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('opens the shared searchable single-select modal and saves the picked id', async () => {
    const onChange = vi.fn();
    mount({ onChange });

    fireEvent.click(screen.getByRole('button', { name: 'Vision model' }));
    expect(screen.getByRole('searchbox', { name: 'Search…' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    // The current value arrives selected, so opening the picker never looks like an empty choice.
    expect(screen.getByRole('button', { name: 'Claude Opus' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'GPT-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('gpt'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vision model' })).toHaveTextContent('GPT-5'));
  });

  it('gives focus back to the trigger when the picker closes', async () => {
    mount();

    const trigger = screen.getByRole('button', { name: 'Vision model' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('searchbox', { name: 'Search…' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Vision model' })));
  });

  it('keeps an empty value on the pinned row rather than selecting nothing', () => {
    mount({ initial: '' });

    fireEvent.click(screen.getByRole('button', { name: 'Vision model' }));

    expect(screen.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');
  });
});
