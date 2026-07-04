import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { SettingCard } from '../../../components/ui/SettingCard';

function W({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

describe('SettingCard', () => {
  it('renders title and control; description moves into a HelpTip', () => {
    render(<W><SettingCard title="Models" description="Enabled executors"><button>ctrl</button></SettingCard></W>);
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ctrl' })).toBeTruthy();
    // description is not inline anymore — it lives in the HelpTip tooltip (revealed on hover/focus)
    expect(screen.queryByText('Enabled executors')).toBeNull();
    // the HelpTip trigger adds a second button next to the control
    expect(screen.getAllByRole('button').length).toBe(2);
  });
});
