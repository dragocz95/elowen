import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Bot, Plug } from 'lucide-react';
import { SettingsLayout } from '../../../components/ui/SettingsLayout';

describe('SettingsLayout', () => {
  it('filters local sections without unmounting the current panel', () => {
    const onChange = vi.fn();
    render(
      <SettingsLayout
        ariaLabel="Settings sections"
        searchPlaceholder="Search settings"
        sections={[{ id: 'brain', label: 'Elowen AI', icon: Bot }, { id: 'plugins', label: 'Plugins', icon: Plug }]}
        value="brain"
        onChange={onChange}
      >
        <div>Unsaved panel content</div>
      </SettingsLayout>,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'plug' } });
    expect(screen.queryByRole('radio', { name: 'Elowen AI' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Plugins' }));
    expect(onChange).toHaveBeenCalledWith('plugins');
    expect(screen.getByText('Unsaved panel content')).toBeInTheDocument();
  });

  it('uses roving focus and arrow keys across sections', () => {
    const onChange = vi.fn();
    render(
      <SettingsLayout
        ariaLabel="Settings sections"
        sections={[{ id: 'brain', label: 'Elowen AI', icon: Bot }, { id: 'plugins', label: 'Plugins', icon: Plug }]}
        value="brain"
        onChange={onChange}
      >
        <div>Panel</div>
      </SettingsLayout>,
    );
    const first = screen.getByRole('radio', { name: 'Elowen AI' });
    const second = screen.getByRole('radio', { name: 'Plugins' });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('plugins');
    expect(second).toHaveFocus();
  });
});
