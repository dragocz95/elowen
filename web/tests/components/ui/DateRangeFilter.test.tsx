import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { DateRangeFilter } from '../../../components/ui/DateRangeFilter';
import { DEFAULT_RANGE } from '../../../lib/dateRange';

const renderFilter = (onChange = vi.fn()) => {
  render(
    <LanguageProvider>
      <DateRangeFilter value={DEFAULT_RANGE} onChange={onChange} />
    </LanguageProvider>,
  );
  return onChange;
};

describe('DateRangeFilter', () => {
  it('is collapsed until the trigger is clicked', () => {
    renderFilter();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('picking a preset reports it and closes the popover', () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // Preset buttons render in order [today, 7d, 30d, 90d, all]; the 5th is "all".
    const presets = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') !== null);
    fireEvent.click(presets[4]);
    expect(onChange).toHaveBeenCalledWith({ preset: 'all', from: null, to: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('editing the from date switches to a custom range', () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-06-01' } });
    expect(onChange).toHaveBeenCalledWith({ preset: 'custom', from: '2026-06-01', to: null });
  });
});
