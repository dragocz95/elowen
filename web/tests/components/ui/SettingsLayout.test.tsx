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
    expect(first).toHaveClass('border-accent');
    expect(first).not.toHaveClass('rounded-lg');
    expect(second).toHaveAttribute('tabindex', '-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('plugins');
    expect(second).toHaveFocus();
  });

  it('pins the desktop navigation below the global top bar', () => {
    render(
      <SettingsLayout
        ariaLabel="Settings sections"
        sections={[{ id: 'brain', label: 'Elowen AI', icon: Bot }]}
        value="brain"
        onChange={vi.fn()}
      >
        <div>Panel</div>
      </SettingsLayout>,
    );
    expect(screen.getByRole('complementary')).toHaveClass('lg:top-20');
    expect(screen.getByRole('complementary')).not.toHaveClass('lg:top-5');
  });
});
