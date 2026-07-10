import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ChoiceField } from '../../../components/ui/ChoiceField';

describe('ChoiceField', () => {
  it('uses an inline segmented control for three or fewer options', () => {
    render(<LanguageProvider><ChoiceField title="Mode" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></LanguageProvider>);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps an unknown persisted value visible in the compact picker', () => {
    render(<LanguageProvider><ChoiceField title="Mode" value="legacy" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></LanguageProvider>);
    expect(screen.getByRole('radio', { name: 'legacy' })).toHaveAttribute('aria-checked', 'true');
  });

  it('uses the shared searchable single-select modal for larger choices', () => {
    render(<LanguageProvider><ChoiceField title="Effects" value="auto" onChange={() => {}} options={[
      { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }, { value: 'off', label: 'Off' },
    ]} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('searchbox', { name: 'Search…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });
});
